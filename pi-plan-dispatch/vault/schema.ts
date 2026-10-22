/**
 * Note schema for the agent vault: the note types, their required properties
 * and vocabularies, basename rules, and the frontmatter format.
 *
 * Pure by design: no Pi imports and no local imports, so the CLI's schema
 * checks and this module's tests run without the rest of the dispatcher.
 */

import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;

export type NoteType =
	| "plan"
	| "run"
	| "finding"
	| "decision"
	| "lesson"
	| "project"
	| "codebase"
	| "spec"
	| "idea";

export const NOTE_TYPES: readonly NoteType[] = [
	"plan",
	"run",
	"finding",
	"decision",
	"lesson",
	"project",
	"codebase",
	"spec",
	"idea",
];

export const TYPE_FOLDER: Record<NoteType, string> = {
	plan: "plans",
	run: "runs",
	finding: "findings",
	decision: "decisions",
	lesson: "lessons",
	project: "projects",
	codebase: "codebases",
	spec: "specs",
	idea: "ideas",
};

export const REQUIRED_PROPS: Record<NoteType, readonly string[]> = {
	plan: ["trace", "round", "repo", "status"],
	run: ["trace", "repo", "status", "gate"],
	finding: ["trace", "repo", "severity", "fingerprint", "source", "status"],
	decision: ["project", "repo"],
	lesson: ["project", "repo"],
	project: ["repos"],
	codebase: ["repo", "commit", "graphify_version"],
	spec: ["trace", "repo", "status", "file"],
	idea: ["status", "repo"],
};

export const VOCAB: {
	planRunStatus: string[];
	planStatus: string[];
	specStatus: string[];
	ideaStatus: string[];
	audit: string[];
	gate: string[];
	findingStatus: string[];
	source: string[];
	severity: string[];
} = {
	planRunStatus: ["done", "failed"],
	planStatus: ["draft", "ready", "done", "failed"],
	specStatus: ["draft", "confirmed", "done"],
	ideaStatus: ["open", "taken", "dropped"],
	audit: ["pass", "fail"],
	gate: ["pass", "fail"],
	findingStatus: ["open", "closed"],
	source: ["plan-audit", "auditor", "pair", "security", "gate"],
	severity: ["blocker", "major", "minor", "error", "warn", "info"],
};

export interface Note {
	type: NoteType;
	basename: string;
	props: Record<string, string | string[]>;
	body: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BASENAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REPO_RE = /^[a-z0-9.-]+(\/[a-z0-9._-]+)+$/;
const FINDING_SUFFIX_RE = /-f-([0-9a-f]{8})$/;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const AUDIT_ROUND_RE = /^[1-9][0-9]*$/;
const ABSOLUTE_RE = /^(\/|~\/|[A-Za-z]:[\\/])/;
const LINE_BREAK_RE = /[\r\n]/;
const QUOTE_START_RE = /^["'[\]{}>|*&!%@`,#?:-]/;
const LIST_ITEM_RE = /^ {2}- (.*)$/;

export function slug(s: string): string {
	const joined = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return joined.slice(0, 60).replace(/-+$/, "");
}

export function fingerprintHash(fingerprint: string): string {
	return createHash("sha1").update(fingerprint, "utf8").digest("hex").slice(0, 8);
}

function requiredFor(type: NoteType): readonly string[] {
	return REQUIRED_PROPS[type] ?? [];
}

function isMissing(value: string | string[] | undefined): boolean {
	return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function valueErrors(key: string, value: string | string[]): string[] {
	const errors: string[] = [];
	const items: unknown[] = Array.isArray(value) ? value : [value];
	for (const item of items) {
		if (typeof item !== "string") {
			errors.push(`${key} must be a string or a list of strings`);
			continue;
		}
		if (LINE_BREAK_RE.test(item)) errors.push(`${key} must be a one-line string`);
		if (ABSOLUTE_RE.test(item)) errors.push(`${key} must not be an absolute path`);
	}
	return errors;
}

export function validateNote(note: Note): string[] {
	const type = note.type as string;
	if (!NOTE_TYPES.includes(type as NoteType)) return [`unknown note type: ${type}`];
	const noteType = type as NoteType;
	const props = note.props ?? {};
	const errors: string[] = [];

	for (const key of ["created", "updated"]) {
		const value = props[key];
		if (typeof value !== "string" || !DATE_RE.test(value)) errors.push(`${key} must be YYYY-MM-DD`);
	}
	for (const key of requiredFor(noteType)) {
		if (isMissing(props[key])) errors.push(`missing required property: ${key}`);
	}
	for (const [key, value] of Object.entries(props)) {
		if (key === "type") continue;
		errors.push(...valueErrors(key, value));
	}

	errors.push(...basenameErrors(noteType, note.basename, props));
	errors.push(...vocabErrors(noteType, props));
	errors.push(...repoErrors(noteType, props));
	return errors;
}

function basenameErrors(type: NoteType, basename: string, props: Record<string, string | string[]>): string[] {
	const errors: string[] = [];
	if (typeof basename !== "string" || !BASENAME_RE.test(basename)) {
		errors.push(`basename must match ^[a-z0-9]+(-[a-z0-9]+)*$: ${basename}`);
		return errors;
	}
	if (type === "run" && !basename.endsWith("-run")) errors.push("a run basename must end with -run");
	if (type === "spec" && !basename.endsWith("-spec")) errors.push("a spec basename must end with -spec");
	if (type === "finding") {
		const m = FINDING_SUFFIX_RE.exec(basename);
		if (!m) {
			errors.push("a finding basename must end with -f-<8 hex>");
		} else {
			const fingerprint = props.fingerprint;
			if (typeof fingerprint === "string" && m[1] !== fingerprintHash(fingerprint)) {
				errors.push("the finding basename hash must equal fingerprintHash(fingerprint)");
			}
		}
	}
	const prefixes: Partial<Record<NoteType, string>> = {
		decision: "decision-",
		lesson: "lesson-",
		project: "project-",
		codebase: "codebase-",
		idea: "idea-",
	};
	const prefix = prefixes[type];
	if (prefix && !basename.startsWith(prefix)) errors.push(`a ${type} basename must start with ${prefix}`);
	return errors;
}

function vocabErrors(type: NoteType, props: Record<string, string | string[]>): string[] {
	const errors: string[] = [];
	const check = (key: string, list: string[]) => {
		const value = props[key];
		if (value === undefined) return;
		if (typeof value !== "string" || !list.includes(value)) {
			errors.push(`${key} must be one of: ${list.join(", ")}`);
		}
	};
	if (type === "plan") {
		check("status", VOCAB.planStatus);
		check("audit", VOCAB.audit);
	}
	if (type === "run") check("status", VOCAB.planRunStatus);
	if (type === "spec") check("status", VOCAB.specStatus);
	if (type === "idea") check("status", VOCAB.ideaStatus);
	if (type === "run") check("gate", VOCAB.gate);
	if (type === "finding") {
		check("status", VOCAB.findingStatus);
		check("source", VOCAB.source);
		check("severity", VOCAB.severity);
	}
	const file = props.file;
	if ((type === "plan" || type === "spec") && file !== undefined) {
		if (typeof file !== "string" || !FILE_NAME_RE.test(file) || file.includes("..")) {
			errors.push("file must be a plain file name ending in .md");
		}
	}
	if (type === "plan") {
		const round = props.audit_round;
		if (round !== undefined && (typeof round !== "string" || !AUDIT_ROUND_RE.test(round))) {
			errors.push("audit_round must be a positive whole number");
		}
	}
	return errors;
}

function repoErrors(type: NoteType, props: Record<string, string | string[]>): string[] {
	const errors: string[] = [];
	const repo = props.repo;
	if (Array.isArray(repo)) {
		errors.push("repo must be a single slug");
	} else if (typeof repo === "string" && repo !== "") {
		if (repo === "-") {
			if (type !== "decision" && type !== "lesson" && type !== "idea") {
				errors.push("repo - is allowed on decision, lesson and idea notes only");
			}
		} else if (!REPO_RE.test(repo)) {
			errors.push(`repo must be a slug host/owner/name: ${repo}`);
		}
	}
	if (type === "project") {
		const repos = props.repos;
		if (Array.isArray(repos)) {
			for (const item of repos) {
				if (typeof item !== "string" || !REPO_RE.test(item)) {
					errors.push(`repos entry must be a slug host/owner/name: ${String(item)}`);
				}
			}
		} else if (repos !== undefined) {
			errors.push("repos must be a list");
		}
	}
	return errors;
}

/** A bare scalar is safe only when re-parsing it gives the same text back. */
function bareSafe(value: string): boolean {
	return (
		value !== "" &&
		!/^\s|\s$/.test(value) &&
		!QUOTE_START_RE.test(value) &&
		!LINE_BREAK_RE.test(value) &&
		!value.includes(": ") &&
		!value.includes(" #") &&
		!value.endsWith(":")
	);
}

function quote(value: string): string {
	return bareSafe(value) ? value : JSON.stringify(value);
}

function propertyLines(key: string, value: string | string[]): string[] {
	if (Array.isArray(value)) return [`${key}:`, ...value.map((item) => `  - ${quote(item)}`)];
	return [`${key}: ${quote(String(value))}`];
}

function propertyOrder(type: NoteType, props: Record<string, string | string[]>): string[] {
	const fixed = ["created", "updated", ...requiredFor(type)];
	const extra = Object.keys(props)
		.filter((key) => key !== "type" && !fixed.includes(key))
		.sort();
	return [...fixed, ...extra];
}

export function serializeNote(note: Note): string {
	const props = note.props ?? {};
	const lines = ["---", `type: ${note.type}`];
	for (const key of propertyOrder(note.type, props)) {
		const value = props[key];
		if (value === undefined) continue;
		lines.push(...propertyLines(key, value));
	}
	lines.push("---");
	return `${lines.join("\n")}\n${note.body}`;
}

function parseValue(raw: string): string {
	if (!raw.startsWith('"')) return raw.trim();
	try {
		return JSON.parse(raw) as string;
	} catch {
		throw new Error(`bad quoted value in frontmatter: ${raw}`);
	}
}

export function parseNote(basename: string, text: string): Note {
	if (!text.startsWith("---\n")) throw new Error("note text must start with --- and a newline");
	const lines = text.split("\n");
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === "---") {
			close = i;
			break;
		}
	}
	if (close === -1) throw new Error("note text has no closing --- line");

	const props: Record<string, string | string[]> = {};
	let listKey: string | undefined;
	for (let i = 1; i < close; i++) {
		const line = lines[i];
		const item = LIST_ITEM_RE.exec(line);
		if (item) {
			if (listKey === undefined) throw new Error(`list item without a key: ${line}`);
			const list = props[listKey];
			if (Array.isArray(list)) list.push(parseValue(item[1]));
			continue;
		}
		const sep = line.indexOf(":");
		if (sep <= 0) throw new Error(`bad frontmatter line: ${line}`);
		const key = line.slice(0, sep);
		const rest = line.slice(sep + 1);
		if (rest === "") {
			props[key] = [];
			listKey = key;
			continue;
		}
		props[key] = parseValue(rest.startsWith(" ") ? rest.slice(1) : rest);
		listKey = undefined;
	}

	const type = props.type;
	delete props.type;
	if (typeof type !== "string" || type === "") throw new Error("note has no type");
	return {
		type: type as NoteType,
		basename,
		props,
		body: lines.slice(close + 1).join("\n"),
	};
}
