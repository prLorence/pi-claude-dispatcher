import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalPath, emptyRegistry, listProjects, loadRegistry, removeProject, saveRegistry, upsertProject } from "../plugins/harness-projects/registry.js";

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-projects-"));
}

test("a missing registry file reads as empty", () => {
	const dir = tempDir();
	try {
		const registry = loadRegistry(path.join(dir, "missing.json"));
		assert.deepEqual(registry.projects, {});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("upsert then save then load keeps the record", () => {
	const dir = tempDir();
	try {
		const file = path.join(dir, "nested", "projects.json");
		const registry = emptyRegistry();
		upsertProject(registry, { path: dir, name: "Demo", slug: "github.com/acme/demo" });
		saveRegistry(file, registry);
		const loaded = loadRegistry(file);
		const record = loaded.projects[canonicalPath(dir)];
		assert.equal(record.name, "Demo");
		assert.equal(record.slug, "github.com/acme/demo");
		assert.ok(record.addedAt > 0);
		assert.deepEqual(listProjects(loaded).map((project) => project.name), ["Demo"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("upsert preserves addedAt and updates the rest", () => {
	const registry = emptyRegistry();
	const first = upsertProject(registry, { path: "/tmp/x", name: "X" });
	const second = upsertProject(registry, { path: "/tmp/x", slug: "local-x", pinned: true });
	assert.equal(second.addedAt, first.addedAt);
	assert.equal(second.name, "X");
	assert.equal(second.slug, "local-x");
	assert.equal(second.pinned, true);
	assert.equal(listProjects(registry).length, 1);
});

test("removeProject reports what it removed", () => {
	const registry = emptyRegistry();
	upsertProject(registry, { path: "/tmp/x" });
	assert.equal(removeProject(registry, "/tmp/x"), true);
	assert.equal(removeProject(registry, "/tmp/x"), false);
});

test("pinned projects sort first", () => {
	const registry = emptyRegistry();
	upsertProject(registry, { path: "/tmp/a", name: "A" });
	upsertProject(registry, { path: "/tmp/b", name: "B", pinned: true });
	assert.deepEqual(listProjects(registry).map((project) => project.name), ["B", "A"]);
});
