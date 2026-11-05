import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureProject, projectsStatus } from "../plugins/harness-dispatch/projects.js";

test("projectsStatus creates .plans in every registered repository", () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-projects-"));
	const repoA = path.join(base, "a");
	const repoB = path.join(base, "b");
	fs.mkdirSync(repoA);
	fs.mkdirSync(repoB);
	const registry = path.join(base, "harness-projects.json");
	fs.writeFileSync(
		registry,
		JSON.stringify({
			version: 1,
			projects: {
				[repoA]: { path: repoA, name: "A", updatedAt: 1 },
				[repoB]: { path: repoB, name: "B", updatedAt: 2, pinned: true },
			},
		}),
	);
	try {
		const status = projectsStatus(registry);
		assert.deepEqual(status.map((p) => p.name), ["B", "A"]);
		for (const repo of [repoA, repoB]) {
			for (const dir of ["inbox", "running", "done", "failed", "specs", "decisions", "traces", "sessions"]) {
				assert.equal(fs.existsSync(path.join(repo, ".plans", dir)), true, `${repo} ${dir}`);
			}
		}
		const one = ensureProject(repoA);
		assert.equal(one.plans, path.join(repoA, ".plans"));
		assert.equal(one.inbox, 0);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

test("a session root prefers its git root, then a containing project, then the active project", async () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-session-root-"));
	const repo = path.join(base, "repo");
	const nested = path.join(repo, "src", "deep");
	fs.mkdirSync(nested, { recursive: true });
	fs.mkdirSync(path.join(repo, ".git"));
	try {
		const { sessionRoot } = await import("../plugins/harness-dispatch/projects.js");
		assert.equal(sessionRoot(nested, [{ path: path.join(base, "other") }]), repo);
		const plain = path.join(base, "plain", "inner");
		fs.mkdirSync(plain, { recursive: true });
		assert.equal(sessionRoot(plain, [{ path: path.join(base, "plain") }]), path.join(base, "plain"));
		assert.equal(sessionRoot(plain, [{ path: repo }]), repo);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});
