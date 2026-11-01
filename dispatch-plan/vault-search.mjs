/**
 * The search and recall commands of the agent vault (R6 and R10 of the
 * forget/search spec). Plain Node, no dependencies, loaded lazily by vault.mjs.
 *
 * `searchCommand` runs the read-only `vault-search` binary with an argument
 * array (never a shell string) and shapes its output; `recall` runs the same
 * binary over `eval/golden.json`; `findBinary` names the binary this machine
 * uses. The CLI builds the context `c` and emits the event this module returns.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_LIMIT = 5;
const RECALL_LIMIT = 5;
const STATUS_VALUES = ["active", "any"];
const EVAL_FILE = path.join("eval", "golden.json");
const BIN_DIR = "bin";
const BIN_NAME = "vault-search";
const BUILD_HINT = "Fix: go build -o dispatch-plan/bin/vault-search ./dispatch-plan/vault-search";

function errorText(error) {
	return String(error?.message ?? error);
}

/** `$VAULT_SEARCH_BIN` when set, else the binary next to the installed scripts. */
export function findBinary(env, scriptDir) {
	const fromEnv = env?.VAULT_SEARCH_BIN;
	if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
	return path.join(scriptDir, BIN_DIR, BIN_NAME);
}

function missingBinary(c, binary) {
	c.err(`${BIN_NAME} not found at ${binary}. ${BUILD_HINT}`);
	return { code: 1 };
}

function runBinary(binary, args) {
	return spawnSync(binary, args, { encoding: "utf8" });
}

/** The flag array every call shares, so text and recall reach the binary the same way. */
function binaryArgs(c, options, query) {
	const args = ["--json", "--vault", c.vault];
	if (typeof options.repo === "string" && options.repo !== "") args.push("--repo", options.repo);
	if (options.all === true) args.push("--all");
	if (options.status === "any") args.push("--status", "any");
	if (options.includeWork === true) args.push("--include-work");
	if (options.limit !== undefined) args.push("--limit", String(options.limit));
	args.push("--", query);
	return args;
}

/** The repo mode decides whether the event may hold the query text. */
function repoMode(c, repo) {
	try {
		const repos = c.modules.notes.readRepos(c.vault);
		return c.modules.privacy.modeFor(repos, repo);
	} catch {
		return "none";
	}
}

function textBlock(hit) {
	const score = typeof hit.score === "number" ? hit.score.toFixed(3) : "0.000";
	const lines = [`${hit.basename} | ${hit.type} | ${hit.repo} | ${hit.status} | ${score}`];
	const snippet = Array.isArray(hit.snippet) ? hit.snippet : [];
	for (const line of snippet) lines.push(`  ${line}`);
	return lines.join("\n");
}

/**
 * Run one search, print its text blocks or JSON, and return the trace event.
 * A missing binary, a non-zero exit or unparsable output exits 1 with the build
 * hint; a bad flag value exits 2 before the binary runs.
 */
export function searchCommand(c, options) {
	const status = options.status ?? "active";
	if (!STATUS_VALUES.includes(status)) {
		c.err(`--status must be active or any: ${status}`);
		return { code: 2 };
	}
	if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
		c.err(`--limit must be a positive whole number: ${options.limit}`);
		return { code: 2 };
	}
	const query = typeof options.query === "string" ? options.query : "";
	if (query.trim() === "") {
		c.err("search needs a query");
		return { code: 2 };
	}

	const binary = findBinary(c.env, c.scriptDir);
	const result = runBinary(binary, binaryArgs(c, options, query));
	if (result.error !== undefined) return missingBinary(c, binary);
	if (result.status !== 0) {
		c.err(String(result.stderr ?? "").trim() || `${BIN_NAME} exited ${result.status}`);
		c.err(BUILD_HINT);
		return { code: 1 };
	}

	let hits;
	try {
		hits = JSON.parse(result.stdout);
	} catch {
		hits = undefined;
	}
	if (!Array.isArray(hits)) {
		c.err("unparsable output");
		c.err(BUILD_HINT);
		return { code: 1 };
	}

	if (options.json === true) {
		c.out(JSON.stringify(hits));
	} else {
		for (const hit of hits) c.out(textBlock(hit));
	}

	const limit = options.limit ?? DEFAULT_LIMIT;
	const data = {
		query_len: query.length,
		results: hits.length,
		all: options.all === true,
		status,
		include_work: options.includeWork === true,
		limit,
	};
	if (repoMode(c, options.repo) === "full") data.query = query;
	return { code: 0, event: { kind: "vault.search", data } };
}

/**
 * The share of golden entries whose expected note is in the top 5. An entry
 * whose note no longer exists counts as a miss; a missing or unreadable file
 * returns null, and the caller decides what to print.
 */
export function recall(c) {
	const file = path.join(c.vault, EVAL_FILE);
	if (!fs.existsSync(file)) return null;
	let entries;
	try {
		entries = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		c.err(`eval/golden.json cannot be read: ${errorText(error)}`);
		return null;
	}
	if (!Array.isArray(entries)) {
		c.err("eval/golden.json must be a JSON array");
		return null;
	}

	const binary = findBinary(c.env, c.scriptDir);
	let hits = 0;
	for (const entry of entries) {
		const query = typeof entry?.query === "string" ? entry.query : "";
		const expect = typeof entry?.expect === "string" ? entry.expect : "";
		if (query.trim() === "" || expect === "") continue;
		const known = c.modules.notes.readNote(c.vault, expect);
		if (known === undefined) continue;
		const result = runBinary(binary, binaryArgs(c, { all: true, status: "active", limit: RECALL_LIMIT }, query));
		if (result.error !== undefined || result.status !== 0) {
			c.err(`${BIN_NAME} could not run for eval/golden.json. ${BUILD_HINT}`);
			return null;
		}
		let found;
		try {
			found = JSON.parse(result.stdout);
		} catch {
			found = undefined;
		}
		if (!Array.isArray(found)) {
			c.err(`unparsable output from ${BIN_NAME} for eval/golden.json`);
			return null;
		}
		if (found.some((hit) => hit?.basename === expect)) hits += 1;
	}

	const total = entries.length;
	const ratio = total === 0 ? 0 : Math.round((hits / total) * 100) / 100;
	return { ratio, hits, entries: total };
}
