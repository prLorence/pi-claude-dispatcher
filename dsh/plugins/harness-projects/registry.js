/**
 * The project registry: the local paths the user manages, parsed once.
 *
 * It is a plain JSON file beside the harness data, because this bundle has no
 * package dependencies to import a storage domain with (the profile links the
 * package directory, so `@deepseek-ai/*` and `zod` do not resolve from here),
 * and a profile package.json is never the right home for mutable data.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const REGISTRY_VERSION = 1;

export function defaultRegistryPath(home = os.homedir()) {
	return path.join(home, ".dsh", "harness-projects.json");
}

export function emptyRegistry() {
	return { version: REGISTRY_VERSION, projects: {} };
}

export function loadRegistry(file = defaultRegistryPath()) {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		const projects = raw?.projects && typeof raw.projects === "object" ? raw.projects : {};
		return { version: REGISTRY_VERSION, projects };
	} catch {
		return emptyRegistry();
	}
}

/** Atomic write: a crash leaves the previous registry intact. */
export function saveRegistry(file, registry) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
	return registry;
}

export function canonicalPath(value) {
	const resolved = path.resolve(String(value ?? ""));
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/** Add or refresh one project; returns its record. */
export function upsertProject(registry, { path: projectPath, name, slug, pinned } = {}) {
	const key = canonicalPath(projectPath);
	const current = registry.projects[key] ?? {};
	const record = {
		...current,
		path: key,
		name: name || current.name || path.basename(key),
		slug: slug ?? current.slug,
		pinned: pinned ?? current.pinned ?? false,
		addedAt: current.addedAt ?? Date.now(),
		updatedAt: Date.now(),
	};
	registry.projects[key] = record;
	return record;
}

export function removeProject(registry, projectPath) {
	const key = canonicalPath(projectPath);
	if (!registry.projects[key]) {
		// Accept a path the user typed with a trailing slash or a symlink.
		const match = Object.keys(registry.projects).find((candidate) => candidate === String(projectPath ?? "").trim());
		if (!match) return false;
		delete registry.projects[match];
		return true;
	}
	delete registry.projects[key];
	return true;
}

/** Newest first, pinned first. */
export function listProjects(registry) {
	return Object.values(registry.projects ?? {}).sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
