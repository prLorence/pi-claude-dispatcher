/**
 * The privacy gate for dispatch-time decisions (R5).
 *
 * It reads the repo mode from the extension's own vault code, the way
 * `cmdRepoCheck` in dispatch-plan/vault.mjs does: the vault folder from
 * `findVault`, the allowlist from `readRepos`, the slug from the checkout's
 * origin remote, then `modeFor`. It never runs the installed CLI and never
 * writes.
 *
 * It fails closed: a missing vault, a vault folder that is not there, a
 * malformed repos.json, or any thrown error is "unknown", and only an exact
 * "full" may send task text to the decider.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { findVault, readRepos } from "../vault/notes.ts";
import { modeFor } from "../vault/privacy.ts";
import { repoSlugFromCwd } from "../vault/url.ts";

export type RepoMode = "full" | "meta" | "none" | "unknown";

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

export function repoMode(
	root: string,
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir(),
): RepoMode {
	try {
		const vault = findVault(env, home);
		if (vault === undefined) return "unknown";
		if (!isDirectory(vault.path)) return "unknown";
		const repos = readRepos(vault.path);
		if (repos.malformed === true) return "unknown";
		const slug = repoSlugFromCwd(root, repos.aliases);
		return modeFor(repos, slug);
	} catch {
		return "unknown";
	}
}

export function mayDecide(
	root: string,
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir(),
): boolean {
	return repoMode(root, env, home) === "full";
}
