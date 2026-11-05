/**
 * Vault note parsing and the warm-context composer. Pure: the reader that walks
 * the vault tree lives in vault-read.js, so these functions are tested with
 * plain text and plain records.
 */
import { describeGit, firstLine, truncate } from "./git-parse.js";

const SEVERITY_RANK = { blocker: 0, major: 1, minor: 2, error: 3, warn: 4, info: 5 };

/** Minimal frontmatter reader: scalars, quoted scalars and `- item` lists. */
export function parseNote(text) {
	const raw = String(text ?? "");
	if (!raw.startsWith("---")) return { data: {}, body: raw };
	const end = raw.indexOf("\n---", 3);
	if (end === -1) return { data: {}, body: raw };
	const head = raw.slice(3, end).replace(/^\r?\n/, "");
	const body = raw.slice(raw.indexOf("\n", end + 1) + 1).replace(/^\r?\n/, "");
	const data = {};
	let listKey;
	for (const line of head.split("\n")) {
		if (!line.trim()) continue;
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && listKey) {
			data[listKey].push(unquote(item[1]));
			continue;
		}
		const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!pair) continue;
		const [, key, rest] = pair;
		if (rest === "") {
			data[key] = [];
			listKey = key;
			continue;
		}
		listKey = undefined;
		data[key] = unquote(rest);
	}
	return { data, body };
}

function unquote(value) {
	const text = String(value).trim();
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
	return text;
}

/** A note record the reader hands to the composer. */
export function noteRecord({ basename, type, path, data, body, mtimeMs }) {
	return {
		basename,
		type: data.type || type,
		path,
		repo: data.repo,
		repos: Array.isArray(data.repos) ? data.repos : data.repos ? [data.repos] : [],
		status: data.status,
		severity: data.severity,
		gate: data.gate,
		trace: data.trace,
		plan: data.plan,
		updated: data.updated || data.created || "",
		created: data.created || data.updated || "",
		body,
		title: firstLine(body),
		mtimeMs,
	};
}

export function sortFindings(findings, limit = 3) {
	return [...findings]
		.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || String(b.updated).localeCompare(String(a.updated)))
		.slice(0, limit);
}

export function sortRecent(notes, limit = 2) {
	return [...notes].sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || a.basename.localeCompare(b.basename)).slice(0, limit);
}

/** Project notes whose `repos` list contains the slug, first match wins. */
export function projectFor(projects, slug) {
	return (projects ?? []).find((note) => note.repos.includes(slug));
}

/**
 * The block injected as the session's project context. Ordered so the most
 * useful facts survive a tight budget: identity + git, project intent, open
 * findings, recent runs, then the newest log line.
 */
export function composeWarm({ slug, mode, git, project, findings = [], runs = [], decisions = [], logLines = [], budget = 1200 } = {}) {
	if (!slug) return "";
	const lines = [];
	const where = git?.root ? truncate(git.root.replace(/^\/Users\/[^/]+/, "~"), 80) : "";
	lines.push(`## Project context — ${slug}`);
	const facts = [describeGit(git)];
	if (where) facts.push(`root ${where}`);
	if (mode && mode !== "full") facts.push(`vault mode ${mode}`);
	lines.push(facts.filter(Boolean).join("; "));

	if (project) {
		lines.push(`Project note [[${project.basename}]]:`);
		const bodyLines = String(project.body ?? "")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"))
			.slice(0, 3);
		for (const line of bodyLines) lines.push(`- ${truncate(line.replace(/^[-*]\s*/, ""), 140)}`);
	}

	const recent = sortRecent(runs, 2);
	if (recent.length) {
		lines.push("Recent runs:");
		for (const note of recent) lines.push(`- ${note.basename}: gate ${note.gate ?? "?"}, ${note.status ?? "?"}${note.updated ? ` (${note.updated})` : ""}`);
	}

	const open = sortFindings(findings.filter((note) => note.status !== "closed"), 2);
	if (open.length) {
		lines.push(`Open findings (${open.length} shown):`);
		for (const note of open) lines.push(`- [${note.severity ?? "info"}] ${note.basename}: ${truncate(note.title, 100)}`);
	}

	const knowledge = sortRecent(decisions, 2);
	if (knowledge.length) {
		lines.push(`Decisions/lessons: ${knowledge.map((note) => `[[${note.basename}]]`).join(", ")}`);
	}

	const log = [...logLines].slice(-1);
	if (log.length) lines.push(`Last log: ${truncate(log[0], 200)}`);

	// Drop trailing blocks until the budget fits, then mark the trim.
	let text = lines.join("\n");
	if (text.length > budget) {
		while (lines.length > 3 && text.length > budget) {
			lines.pop();
			text = lines.join("\n");
		}
		if (lines.length > 3) text = `${text}\n[truncated]`;
	}
	return `${text}\n`;
}
