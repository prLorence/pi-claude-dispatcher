/**
 * Review contract shared by pair mode and the security role: the report formats
 * reviewers must produce, a tolerant parser for them, the reviewer prompt, and
 * the feedback text that sends findings back to the implementer.
 *
 * Pure by design: no Pi imports and no local imports, so the parser can be
 * tested alone and reused from any module.
 */

export type ReviewVerdict = "approve" | "changes" | "clean" | "issues" | "unknown";

export interface ReviewFinding {
	severity?: "high" | "medium" | "low";
	/** `path:line`, when the finding points at a place in the repo */
	location?: string;
	text: string;
}

export interface ReviewReport {
	verdict: ReviewVerdict;
	findings: ReviewFinding[];
}

export interface ReviewPromptInput {
	kind: "review" | "security";
	planId: string;
	context: string;
	taskId: string;
	taskBody: string;
	files: string[];
	implementerReport?: string;
	rolePrompt: string;
	round?: number;
}

const VERDICT_RE = /verdict\s*\**\s*:\s*\**\s*([a-z]+)/i;
const FINDINGS_RE = /findings\s*\**\s*:\s*\**/i;
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const SEVERITY_RE = /^(?:[[(]\s*(high|medium|low)\s*[\])]|(high|medium|low)\s*:)\s*/i;
const LOCATION_RE = /^([^\s:]+:\d+)\s*:\s*(.+)$/;
const NONE_RE = /^none[.!]?$/i;
const KNOWN_VERDICTS = new Set<ReviewVerdict>(["approve", "changes", "clean", "issues"]);
/** Sections a worker report may add after the review; they are not findings. */
const STOP_RE = /^(status|changed|tests|notes|needs|verdict)\s*:/i;

const FORMATS: Record<ReviewPromptInput["kind"], string> = {
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

function parseVerdict(output: string): ReviewVerdict {
	const m = VERDICT_RE.exec(output);
	if (!m) return "unknown";
	const v = m[1].toLowerCase() as ReviewVerdict;
	return KNOWN_VERDICTS.has(v) ? v : "unknown";
}

/** One bullet's content as a finding: optional severity tag, optional `path:line`. */
function toFinding(content: string): ReviewFinding | undefined {
	let s = content.trim();
	if (!s) return undefined;
	let severity: ReviewFinding["severity"];
	const sm = SEVERITY_RE.exec(s);
	if (sm) {
		severity = (sm[1] || sm[2]).toLowerCase() as ReviewFinding["severity"];
		s = s.slice(sm[0].length).trim();
	}
	const lm = LOCATION_RE.exec(s);
	const finding: ReviewFinding = { text: s };
	if (severity) finding.severity = severity;
	if (lm && lm[2].trim()) {
		finding.location = lm[1];
		finding.text = lm[2].trim();
	}
	return finding.text ? finding : undefined;
}

/**
 * Parse a reviewer's final message. Tolerant on purpose: case-insensitive,
 * markdown bold, prose around the report, bullets or plain lines, and `none`.
 * A missing or unrecognised verdict is `unknown`; the findings are kept as
 * written, even when they contradict the verdict.
 */
export function parseReviewReport(output: string): ReviewReport {
	const text = typeof output === "string" ? output : "";
	const verdict = parseVerdict(text);
	const start = FINDINGS_RE.exec(text);
	if (!start) return { verdict, findings: [] };

	const findings: ReviewFinding[] = [];
	let current: ReviewFinding | undefined;
	// Bullets may wrap onto indented lines; a plain report is one finding per line.
	let mode: "bullet" | "plain" | undefined;
	for (const raw of text.slice(start.index + start[0].length).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const plain = line.replace(/\*/g, "").trim();
		if (STOP_RE.test(plain)) break;
		// `none` closes the findings list: anything after it is commentary.
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
			// A continuation is indented under its bullet; other prose ends the list.
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

/** Prompt for a reviewer worker; `kind` decides the report format it must use. */
export function buildReviewPrompt(a: ReviewPromptInput): string {
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

function describeFinding(f: ReviewFinding): string {
	const tags = [f.severity ? `[${f.severity}]` : "", f.location ? `${f.location}:` : ""].filter(Boolean).join(" ");
	return `${tags} ${f.text}`.trim();
}

/**
 * Feedback block for the implementer's next attempt: who asked, numbered
 * findings, and an instruction to fix the cause rather than argue.
 */
export function feedbackFromFindings(findings: ReviewFinding[], reviewer: string): string {
	const who = reviewer.trim() || "the reviewer";
	const head = `## Review findings from ${who}`;
	const intro = `${who} reviewed your last attempt and did not approve it. Fix the cause of each finding below. If a finding is wrong, explain why under NOTES; otherwise fix its cause. Do not change anything outside your files.`;
	if (!findings.length) {
		return `${head}\n${intro}\n\nNo findings were listed. Re-read the task and the files you changed, then fix what is wrong.`;
	}
	const items = findings.map((f, i) => `${i + 1}. ${describeFinding(f)}`);
	return `${head}\n${intro}\n\n${items.join("\n")}`;
}
