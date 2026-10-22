import { execFileSync } from "node:child_process";

const REJECT_PREFIX = /^(?:file:|\/|\.\/|\.\.\/|~)/i;
const SCHEME_URL = /^(?:ssh|git|https?):\/\//i;
const ANY_SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_STYLE = /^(?:[^@/]+@)?([^:/]+):(.+)$/;

function replaceAlias(host: string, aliases: Record<string, string>): string {
	const table: Record<string, string> = {};
	for (const key of Object.keys(aliases)) {
		table[key.trim().toLowerCase()] = aliases[key].trim().toLowerCase();
	}
	return table[host] ?? host;
}

function joinSlug(host: string, rawSegments: string[], aliases: Record<string, string>): string | undefined {
	const segments = rawSegments
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s !== "");
	if (segments.length < 2) return undefined;
	const last = segments.length - 1;
	const name = segments[last].endsWith(".git") ? segments[last].slice(0, -".git".length) : segments[last];
	if (name === "") return undefined;
	const realHost = replaceAlias(host.trim().toLowerCase(), aliases);
	if (realHost === "") return undefined;
	return [realHost, ...segments.slice(0, last), name].join("/");
}

export function normalizeRemote(remote: string, aliases: Record<string, string> = {}): string | undefined {
	const url = remote.trim();
	if (url === "") return undefined;
	if (REJECT_PREFIX.test(url)) return undefined;
	if (SCHEME_URL.test(url)) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return undefined;
		}
		return joinSlug(parsed.hostname, parsed.pathname.split("/"), aliases);
	}
	if (ANY_SCHEME_URL.test(url)) return undefined;
	const scp = SCP_STYLE.exec(url);
	if (scp === null) return undefined;
	return joinSlug(scp[1], scp[2].split("/"), aliases);
}

function gitOutput(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

export function repoSlugFromCwd(cwd: string, aliases: Record<string, string> = {}): string | undefined {
	let toplevel: string;
	try {
		toplevel = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		return undefined;
	}
	if (toplevel === "") return undefined;
	let remote: string;
	try {
		remote = gitOutput(toplevel, ["remote", "get-url", "origin"]);
	} catch {
		return undefined;
	}
	return normalizeRemote(remote, aliases);
}
