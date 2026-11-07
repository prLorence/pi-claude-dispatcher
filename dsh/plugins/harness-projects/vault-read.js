/**
 * Read-only view of the agent vault. This module never writes: `vault.mjs`
 * remains the only writer, so the plugin cannot corrupt the lock, the schema or
 * the privacy rules. It reads the same note files the CLI writes, plus
 * `repos.json` for each repo's mode and `log.md` for the newest lines.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { noteRecord, parseNote, projectFor, sortRecent, composeWarm } from "./vault-notes.js";

export const NOTE_DIRS = ["projects", "codebases", "findings", "runs", "decisions", "lessons", "plans", "specs", "ideas"];
const MAX_NOTE_BYTES = 128 * 1024;

export function defaultSkillRoot(home = os.homedir()) {
	return path.join(home, ".claude", "skills", "dispatch-plan");
}

/** `vault.mjs resolve --json` → {path, host, remote}; undefined on any failure. */
export function resolveVaultPath({ skillRoot = defaultSkillRoot(), timeoutMs = 8000 } = {}) {
	const script = path.join(skillRoot, "vault.mjs");
	if (!fs.existsSync(script)) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const child = execFile(process.execPath, [script, "resolve", "--json"], { timeout: timeoutMs, env: process.env, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			if (error) return resolve(undefined);
			try {
				const parsed = JSON.parse(stdout);
				resolve(typeof parsed?.path === "string" ? parsed : undefined);
			} catch {
				resolve(undefined);
			}
		});
		// A CLI that reads stdin must see EOF, or it can hang until the timeout.
		child.stdin?.end();
	});
}

/** `repos.json` → Map(slug → mode). Missing or malformed reads as "none" for everyone. */
export function readRepoModes(vaultPath) {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(vaultPath, "repos.json"), "utf8"));
		const modes = new Map();
		for (const [slug, value] of Object.entries(raw?.repos ?? {})) {
			const mode = value?.mode;
			modes.set(slug.toLowerCase(), mode === "full" || mode === "meta" ? mode : "none");
		}
		return modes;
	} catch {
		return new Map();
	}
}

/** Every note file under the vault's note folders, newest mtime first. */
export async function readNotes(vaultPath) {
	const notes = { projects: [], codebases: [], findings: [], runs: [], decisions: [], lessons: [], plans: [], specs: [], ideas: [] };
	await Promise.all(
		NOTE_DIRS.map(async (dir) => {
			const full = path.join(vaultPath, dir);
			let entries;
			try {
				entries = await fs.promises.readdir(full, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
				const file = path.join(full, entry.name);
				try {
					const stat = await fs.promises.stat(file);
					if (stat.size > MAX_NOTE_BYTES) continue;
					const text = await fs.promises.readFile(file, "utf8");
					const { data, body } = parseNote(text);
					notes[dir].push(noteRecord({ basename: entry.name.slice(0, -3), type: dir, path: file, data, body, mtimeMs: stat.mtimeMs }));
				} catch {
					// One unreadable note never breaks the warm context.
				}
			}
		}),
	);
	return notes;
}

/** The `- ` lines of log.md that name this repo, newest last. */
export function readLogLines(vaultPath, slug) {
	try {
		const text = fs.readFileSync(path.join(vaultPath, "log.md"), "utf8");
		return text
			.split("\n")
			.filter((line) => line.trim().startsWith("- ") && line.includes(slug))
			.slice(-20)
			.map((line) => line.replace(/^- /, "").trim());
	} catch {
		return [];
	}
}

/**
 * A cached snapshot of everything a warm block needs. The vault is small
 * (hundreds of notes), so a 15 s cache keeps prompt assembly free of I/O while
 * staying fresh for a new turn.
 */
export function createVaultReader({ skillRoot, ttlMs = 15_000, log } = {}) {
	let cached = { at: 0, value: undefined };
	let resolving;

	const snapshot = async () => {
		const now = Date.now();
		if (cached.value && now - cached.at < ttlMs) return cached.value;
		if (!resolving) {
			resolving = (async () => {
				const resolved = await resolveVaultPath({ skillRoot });
				const vaultPath = resolved?.path;
				if (!vaultPath || !fs.existsSync(vaultPath)) {
					return { vaultPath: undefined, modes: new Map(), notes: undefined, at: Date.now() };
				}
				const [notes] = await Promise.all([readNotes(vaultPath)]);
				return { vaultPath, modes: readRepoModes(vaultPath), notes, at: Date.now() };
			})()
				.catch((error) => {
					log?.(`harness-projects: vault read failed: ${error instanceof Error ? error.message : String(error)}`);
					return { vaultPath: undefined, modes: new Map(), notes: undefined, at: Date.now() };
				})
				.finally(() => {
					resolving = undefined;
				});
		}
		const value = await resolving;
		cached = { at: Date.now(), value };
		return value;
	};

	return {
		snapshot,
		invalidate() {
			cached = { at: 0, value: undefined };
		},
		/** Mode for one slug: "full", "meta" or "none". Unlisted reads as none. */
		async modeOf(slug) {
			const snap = await snapshot();
			return snap.modes.get(slug) ?? "none";
		},
		/** The compact markdown block for one repo, or "" when there is nothing to say. */
		async warmFor(repo, { budget = 1200 } = {}) {
			const snap = await snapshot();
			const slug = repo?.slug;
			if (!slug) return "";
			const mode = snap.modes.get(slug) ?? "none";
			const notes = snap.notes;
			if (!notes || mode === "none") return composeWarm({ slug, mode, git: repo.git, project: undefined });
			const matches = (note) => note.repo === slug || note.repos?.includes(slug);
			return composeWarm({
				slug,
				mode,
				git: repo.git,
				project: projectFor(notes.projects, slug),
				codebase: sortRecent(notes.codebases.filter(matches), 1)[0],
				findings: notes.findings.filter(matches),
				runs: notes.runs.filter(matches),
				decisions: [...notes.decisions.filter(matches), ...notes.lessons.filter(matches)],
				logLines: snap.vaultPath ? readLogLines(snap.vaultPath, slug) : [],
				budget,
			});
		},
	};
}
