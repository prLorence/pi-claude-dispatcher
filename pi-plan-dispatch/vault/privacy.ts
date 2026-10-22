/**
 * The vault's privacy rules (R13): the repos.json allowlist, the mode that
 * governs a note, and the body checks that keep a `none` repo out of the vault.
 *
 * Pure by design apart from `normalizeRemote`, so the CLI and its tests can use
 * it without the rest of the dispatcher.
 */

import type { Note } from "./schema.ts";
import { normalizeRemote } from "./url.ts";

export type Mode = "full" | "meta" | "none";

export interface Repos {
	repos: Record<string, { mode: Mode }>;
	aliases: Record<string, string>;
	malformed?: boolean;
}

const MODES: readonly Mode[] = ["full", "meta", "none"];
const META_TYPES: readonly string[] = ["run", "decision", "lesson"];
const META_RUN_KEYS: readonly string[] = [
	"gate",
	"tasks_done",
	"tasks_failed",
	"cost",
	"models",
	"faults",
];
const FENCED_CODE_RE = /^[ \t]*```/m;
const TOKEN_SPLIT_RE = /[\s`"'[\]{}()<>,;:]+/;
const TOKEN_EDGE = "(?<![A-Za-z0-9._-])";
const TOKEN_EDGE_END = "(?![A-Za-z0-9._-])";

function malformedRepos(): Repos {
	return { repos: {}, aliases: {}, malformed: true };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function aliasTable(value: unknown): Record<string, string> {
	const aliases: Record<string, string> = {};
	if (!isObject(value)) return aliases;
	for (const key of Object.keys(value)) {
		const target = value[key];
		if (typeof target === "string") aliases[key] = target;
	}
	return aliases;
}

function isMode(value: unknown): value is Mode {
	return typeof value === "string" && MODES.includes(value as Mode);
}

function normalizeKey(key: string, aliases: Record<string, string>): string | undefined {
	const trimmed = key.trim();
	if (trimmed === "") return undefined;
	if (!trimmed.includes(":") && !trimmed.includes("@")) {
		return trimmed.toLowerCase();
	}
	return normalizeRemote(trimmed, aliases);
}

export function parseRepos(json: string | undefined): Repos {
	if (json === undefined) return malformedRepos();
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return malformedRepos();
	}
	if (!isObject(parsed)) return malformedRepos();
	if (!isObject(parsed.repos)) return malformedRepos();
	const aliases = aliasTable(parsed.aliases);
	const repos: Record<string, { mode: Mode }> = {};
	for (const key of Object.keys(parsed.repos)) {
		const entry = parsed.repos[key];
		if (!isObject(entry) || !isMode(entry.mode)) return malformedRepos();
		const slug = normalizeKey(key, aliases);
		if (slug === undefined) return malformedRepos();
		repos[slug] = { mode: entry.mode };
	}
	return { repos, aliases };
}

export function modeFor(repos: Repos, slug: string | undefined): Mode {
	if (slug === undefined || repos.malformed) return "none";
	const key = slug.toLowerCase();
	if (!Object.hasOwn(repos.repos, key)) return "none";
	const mode = repos.repos[key]?.mode;
	return isMode(mode) ? mode : "none";
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function needleFound(text: string, needle: string): boolean {
	const re = new RegExp(`${TOKEN_EDGE}${escapeRegex(needle)}${TOKEN_EDGE_END}`, "i");
	return re.test(text);
}

export function leaksNoneRepo(repos: Repos, text: string): string[] {
	if (text === "") return [];
	const found: string[] = [];
	const seen = new Set<string>();
	for (const slug of Object.keys(repos.repos)) {
		if (repos.repos[slug]?.mode !== "none") continue;
		const short = slug.split("/").slice(-2).join("/");
		for (const needle of [slug, short]) {
			if (needle === "" || seen.has(needle)) continue;
			if (!needleFound(text, needle)) continue;
			seen.add(needle);
			found.push(needle);
		}
	}
	return found;
}

export function renderMetaRunBody(props: Record<string, string | string[]>): string {
	const lines: string[] = [];
	for (const key of META_RUN_KEYS) {
		const value = props[key];
		if (value === undefined) continue;
		const text = Array.isArray(value) ? value.join(", ") : value;
		lines.push(`- ${key}: ${text}`);
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function bodyHasFencedCode(body: string): boolean {
	return FENCED_CODE_RE.test(body);
}

function tokensOf(text: string): string[] {
	return text
		.split(TOKEN_SPLIT_RE)
		.map((token) => token.replace(/\.$/, ""))
		.filter((token) => token !== "");
}

function bodyTrackedFile(body: string, trackedFiles: Set<string>): string | undefined {
	for (const token of tokensOf(body)) {
		if (trackedFiles.has(token)) return token;
	}
	return undefined;
}

function projectRepoErrors(repos: Repos, note: Note): string[] {
	const errors: string[] = [];
	const raw = note.props.repos;
	const entries: unknown[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		if (modeFor(repos, entry) === "none") {
			errors.push(`project repos entry ${entry} is not allowed`);
		}
	}
	return errors;
}

function metaErrors(repos: Repos, note: Note, trackedFiles: Set<string> | undefined): string[] {
	if (!META_TYPES.includes(note.type)) {
		return [`${note.type} notes are not allowed for a meta repo`];
	}
	if (note.type !== "run") {
		const errors: string[] = [];
		if (bodyHasFencedCode(note.body)) {
			errors.push(`meta ${note.type} body must not contain fenced code blocks`);
		}
		if (trackedFiles !== undefined) {
			const token = bodyTrackedFile(note.body, trackedFiles);
			if (token !== undefined) {
				errors.push(`meta ${note.type} body must not name a tracked file: ${token}`);
			}
		}
		return errors;
	}
	if (note.body.trim() === renderMetaRunBody(note.props).trim()) return [];
	return ["run body must match its meta fields"];
}

function leakErrors(repos: Repos, note: Note): string[] {
	const errors: string[] = [];
	const check = (text: string): void => {
		for (const needle of leaksNoneRepo(repos, text)) {
			errors.push(`names a repo that is not allowed: ${needle}`);
		}
	};
	check(note.body);
	for (const key of Object.keys(note.props)) {
		if (key === "repo" || key === "repos") continue;
		const value = note.props[key];
		for (const item of Array.isArray(value) ? value : [value]) {
			if (typeof item === "string") check(item);
		}
	}
	return errors;
}

export function checkNote(repos: Repos, note: Note, trackedFiles?: Set<string>): string[] {
	const errors: string[] = [];
	if (note.type === "project") {
		errors.push(...projectRepoErrors(repos, note));
	} else {
		const rawRepo = note.props.repo;
		const repo = typeof rawRepo === "string" ? rawRepo : undefined;
		const mode = repo === "-" ? "meta" : modeFor(repos, repo);
		if (mode === "none") {
			errors.push(`repo ${repo ?? "(none)"} is not allowed`);
		} else if (mode === "meta") {
			errors.push(...metaErrors(repos, note, trackedFiles));
		}
	}
	errors.push(...leakErrors(repos, note));
	return [...new Set(errors)];
}
