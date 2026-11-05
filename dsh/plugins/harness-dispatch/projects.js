/**
 * Read the `harness-projects` registry and keep each managed repository's
 * `.plans/` tree present. The registry file is a plain JSON contract; this
 * module does not import the projects plugin.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDirs, getDirs } from "./config.js";

export function defaultProjectRegistry(home = os.homedir()) {
	return path.join(home, ".dsh", "harness-projects.json");
}

/** Project records from the registry, newest first. */
export function loadProjects(file = defaultProjectRegistry()) {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		const projects = raw && typeof raw.projects === "object" && raw.projects !== null ? Object.values(raw.projects) : [];
		return projects
			.filter((p) => p && typeof p.path === "string" && p.path.trim() !== "")
			.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	} catch {
		return [];
	}
}

/** Ensure `.plans/` exists in one repository and report its plan counts. */
export function ensureProject(root) {
	const dirs = getDirs(root);
	ensureDirs(dirs);
	const count = (dir) => {
		try {
			return fs.readdirSync(dir).filter((name) => name.endsWith(".md") || name.endsWith(".md.draft")).length;
		} catch {
			return 0;
		}
	};
	return { root, plans: dirs.root, inbox: count(dirs.inbox), running: count(dirs.running) };
}

export function projectsStatus(file = defaultProjectRegistry()) {
	return loadProjects(file).map((project) => {
		try {
			return { ...ensureProject(project.path), name: project.name, slug: project.slug, pinned: Boolean(project.pinned) };
		} catch (error) {
			return { root: project.path, plans: path.join(project.path, ".plans"), error: error instanceof Error ? error.message : String(error), name: project.name, slug: project.slug };
		}
	});
}


/** Walk up from a directory to the nearest `.git` root. */
export function findGitRoot(start) {
	let dir = path.resolve(String(start || "."));
	for (;;) {
		try {
			if (fs.existsSync(path.join(dir, ".git"))) return dir;
		} catch {
			return undefined;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * The repository a session should dispatch. A git working directory wins;
 * otherwise a registered project containing the directory; otherwise the
 * most recently active registered project.
 */
export function sessionRoot(cwd, projects = [], fallback) {
	const git = findGitRoot(cwd);
	if (git) return git;
	const resolved = path.resolve(String(cwd || "."));
	for (const project of projects) {
		const root = path.resolve(project.path);
		if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return root;
	}
	return projects[0]?.path || fallback || resolved;
}
