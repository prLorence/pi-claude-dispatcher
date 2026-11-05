/**
 * Pure parsers for git output. No I/O, no child processes: the runner lives in
 * git.js and the tests drive these functions with recorded output.
 */

const HOSTS_WITH_PORT = /^(?:ssh|git|https?):\/\//;

/**
 * `git status --porcelain=v2 --branch` → one flat record.
 *
 * Headers:
 *   # branch.oid <sha> | # branch.head <name> | # branch.upstream <remote/branch>
 *   # branch.ab +<ahead> -<behind>
 * Entries: `1` changed, `2` renamed, `u` unmerged, `?` untracked, `!` ignored.
 */
export function parseStatus(text) {
	const out = {
		oid: null,
		branch: null,
		detached: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		dirty: 0,
		untracked: 0,
		unmerged: 0,
		renamed: 0,
	};
	for (const line of String(text ?? "").split("\n")) {
		if (line.startsWith("# branch.oid ")) out.oid = line.slice(13).trim();
		else if (line.startsWith("# branch.head ")) {
			const head = line.slice(14).trim();
			out.detached = head === "(detached)";
			out.branch = out.detached ? null : head;
		} else if (line.startsWith("# branch.upstream ")) out.upstream = line.slice(18).trim() || null;
		else if (line.startsWith("# branch.ab ")) {
			const match = /\+(\d+)\s+-(\d+)/.exec(line);
			if (match) {
				out.ahead = Number(match[1]);
				out.behind = Number(match[2]);
			}
		} else if (line.startsWith("1 ")) out.dirty += 1;
		else if (line.startsWith("2 ")) {
			out.dirty += 1;
			out.renamed += 1;
		} else if (line.startsWith("u ")) out.unmerged += 1;
		else if (line.startsWith("? ")) out.untracked += 1;
	}
	return out;
}

/**
 * `git log --format=%H%x1f%h%x1f%s%x1f%an%x1f%ar` → commits, newest first.
 * The unit separator keeps subjects that contain `|` or tabs intact.
 */
export function parseLog(text) {
	const commits = [];
	for (const line of String(text ?? "").split("\n")) {
		if (!line.trim()) continue;
		const [hash, short, subject, author, date] = line.split("\x1f");
		if (!hash) continue;
		commits.push({
			hash: hash.trim(),
			short: (short ?? hash.slice(0, 7)).trim(),
			subject: (subject ?? "").trim(),
			author: (author ?? "").trim(),
			date: (date ?? "").trim(),
		});
	}
	return commits;
}

/**
 * A remote URL → the vault's `host/owner/name` slug, lowercased.
 *
 * Accepts the four forms git hands out:
 *   git@github.com:owner/name.git
 *   ssh://git@github.com:22/owner/name.git
 *   https://github.com/owner/name.git
 *   /srv/git/owner/name.git and file:///… (no host ⇒ undefined)
 */
export function slugFromRemote(url) {
	const raw = String(url ?? "").trim();
	if (!raw) return undefined;
	let host;
	let rest;
	const scp = /^([^\s/:@]+@)?([^:\s/]+):(.+)$/.exec(raw);
	if (!HOSTS_WITH_PORT.test(raw) && scp && !raw.includes("://")) {
		host = scp[2];
		rest = scp[3];
	} else if (HOSTS_WITH_PORT.test(raw)) {
		try {
			const parsed = new URL(raw);
			if (!parsed.hostname) return undefined;
			host = parsed.hostname;
			rest = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return undefined;
		}
	} else {
		return undefined;
	}
	rest = rest.replace(/\.git$/i, "").replace(/\/+$/, "");
	const parts = rest.split("/").filter(Boolean);
	if (parts.length < 2) return undefined;
	const slug = `${host}/${parts[0]}/${parts[1]}`.toLowerCase();
	return /^[a-z0-9.-]+\/[a-z0-9._-]+\/[a-z0-9._-]+$/.test(slug) ? slug : undefined;
}

/** `local/<basename>` for a repo with no usable remote. */
export function localSlug(repoPath) {
	const name = String(repoPath ?? "")
		.replace(/[\\/]+$/, "")
		.split(/[\\/]/)
		.pop();
	return slugify(`local/${name ?? "repo"}`);
}

/** The vault's baseline `slug()`: lowercase, non-alphanumerics → single dash, trimmed, 60 chars. */
export function slugify(value) {
	return (
		String(value ?? "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "repo"
	);
}

/** Short one-line git state for a warm block or a list row. */
export function describeGit(git) {
	if (!git || git.error) return `git: ${git?.error ?? "unavailable"}`;
	const parts = [];
	parts.push(git.detached ? "detached HEAD" : `on ${git.branch ?? "unknown"}`);
	if (git.upstream) {
		const drift = [git.ahead > 0 ? `${git.ahead} ahead` : "", git.behind > 0 ? `${git.behind} behind` : ""].filter(Boolean);
		parts.push(drift.length ? drift.join(", ") : "up to date");
	}
	if (git.dirty) parts.push(`${git.dirty} changed`);
	if (git.untracked) parts.push(`${git.untracked} untracked`);
	if (git.unmerged) parts.push(`${git.unmerged} unmerged`);
	const last = git.lastCommit;
	if (last) parts.push(`last commit ${last.date || last.short}: ${truncate(last.subject, 70)}`);
	return parts.filter(Boolean).join(", ");
}

export function truncate(text, max) {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** First non-empty line of a note body, whitespace-collapsed. */
export function firstLine(body) {
	for (const line of String(body ?? "").split("\n")) {
		if (!line.trim()) continue;
		return line.trim();
	}
	return "";
}
