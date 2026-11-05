/**
 * Review contract shared by pair mode and the security role: report formats, a
 * tolerant parser, the reviewer prompt and feedback. Pure, no local imports.
 */

const VERDICT_RE = /verdict\s*\**\s*:\s*\**\s*([a-z]+)/i;
const FINDINGS_RE = /findings\s*\**\s*:\s*\**/i;
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const SEVERITY_RE = /^(?:[[(]\s*(high|medium|low)\s*[\])]|(high|medium|low)\s*:)\s*/i;
const LOCATION_RE = /^([^\s:]+:\d+)\s*:\s*(.+)$/;
const NONE_RE = /^none[.!]?$/i;
const KNOWN_VERDICTS = new Set(["approve", "changes", "clean", "issues"]);
const STOP_RE = /^(status|changed|tests|notes|needs|verdict)\s*:/i;

const FORMATS = {
	review: [
		"VERDICT: approve | changes",
		'FINDINGS: <one bullet per finding, or "none">',
		"- <path>:<line>: <problem>. <fix>.",
	].join("\n"),
	security: [
		"VERDICT: clean | issues",
		'FINDINGS: <one bullet per finding, or "none">',
		"- [high|medium|low] <path>:<line>: <problem>. <fix>.",
	].join("\n"),
};

const GROUNDING = [
	"## Grounding rules",
	"- Read the task's files before judging them. Never report from memory.",
	"- Inspect with read tools and `git diff -- <files>` limited to the task's files. The checkout may contain unrelated uncommitted edits; judge only the task's files and instructions.",
	"- Never invent function names, APIs, file paths or package names. Verify them by reading the code or searching for them.",
	"- Only report what you actually inspected. Do not run commands that change files.",
	"- Do not fix anything yourself: your findings go in the final message.",
].join("\n");

function parseVerdict(output) {
	const m = VERDICT_RE.exec(output);
	if (!m) return "unknown";
	const v = m[1].toLowerCase();
	return KNOWN_VERDICTS.has(v) ? v : "unknown";
}

function toFinding(content) {
	let s = content.trim();
	if (!s) return undefined;
	let severity;
	const sm = SEVERITY_RE.exec(s);
	if (sm) {
		severity = (sm[1] || sm[2]).toLowerCase();
		s = s.slice(sm[0].length).trim();
	}
	const lm = LOCATION_RE.exec(s);
	const finding = { text: s };
	if (severity) finding.severity = severity;
	if (lm && lm[2].trim()) {
		finding.location = lm[1];
		finding.text = lm[2].trim();
	}
	return finding.text ? finding : undefined;
}

export function parseReviewReport(output) {
	const text = typeof output === "string" ? output : "";
	const verdict = parseVerdict(text);
	const start = FINDINGS_RE.exec(text);
	if (!start) return { verdict, findings: [] };

	const findings = [];
	let current;
	let mode;
	for (const raw of text.slice(start.index + start[0].length).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const plain = line.replace(/\*/g, "").trim();
		if (STOP_RE.test(plain)) break;
		if (NONE_RE.test(plain)) break;
		const bullet = BULLET_RE.exec(raw);
		if (bullet) {
			const content = bullet[1].replace(/\*/g, "").trim();
			if (NONE_RE.test(content)) break;
			mode = "bullet";
			current = toFinding(bullet[1]);
			if (current) findings.push(current);
			continue;
		}
		if (mode === "bullet") {
			if (current && /^\s/.test(raw)) {
				current.text = `${current.text} ${plain}`.trim();
				continue;
			}
			break;
		}
		mode = "plain";
		current = toFinding(line);
		if (current) findings.push(current);
	}
	return { verdict, findings };
}

export function buildReviewPrompt(a) {
	const who = a.kind === "security" ? "security reviewer" : "reviewer";
	const owned = a.files.length
		? `Files the task owned: ${a.files.join(", ")}. Judges only these, plus anything the task instructions name.`
		: "The task lists no files. Judge only what its instructions describe.";
	const implementer = a.implementerReport
		? `## The implementer's report\n${a.implementerReport}`
		: "## The implementer's report\nNot provided. Inspect the files yourself with read tools and `git diff`.";
	return [
		`You are the ${who} for task "${a.taskId}" of plan "${a.planId}"${a.round ? `, review round ${a.round}` : ""}.`,
		a.rolePrompt ? `## Your role\n${a.rolePrompt}` : "",
		a.context ? `## Plan context\n${a.context}` : "",
		`## The task you are reviewing\n${a.taskBody}`,
		owned,
		implementer,
		GROUNDING,
		`## Final message format\nEnd with exactly these sections, in plain text:\n${FORMATS[a.kind]}\nDo not add another format, and do not wrap the report in a code block.`,
	]
		.filter(Boolean)
		.join("\n\n");
}

function describeFinding(f) {
	const tags = [f.severity ? `[${f.severity}]` : "", f.location ? `${f.location}:` : ""].filter(Boolean).join(" ");
	return `${tags} ${f.text}`.trim();
}

export function feedbackFromFindings(findings, reviewer) {
	const who = reviewer.trim() || "the reviewer";
	const head = `## Review findings from ${who}`;
	const intro = `${who} reviewed your last attempt and did not approve it. Fix the cause of each finding below. If a finding is wrong, explain why under NOTES; otherwise fix its cause. Do not change anything outside your files.`;
	if (!findings.length) {
		return `${head}\n${intro}\n\nNo findings were listed. Re-read the task and the files you changed, then fix what is wrong.`;
	}
	const items = findings.map((f, i) => `${i + 1}. ${describeFinding(f)}`);
	return `${head}\n${intro}\n\n${items.join("\n")}`;
}
