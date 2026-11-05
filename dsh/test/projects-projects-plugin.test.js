import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { apply } from "../plugins/harness-projects/index.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };

function makeRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-projects-repo-"));
	execFileSync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
	execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "first commit"], { env: GIT_ENV });
	execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/demo.git"], { env: GIT_ENV });
	return dir;
}

function fakeCtx(directory) {
	const rootAgent = { id: "root-agent", session: { id: "s1" } };
	const childAgent = { id: "child-agent", session: { id: "s2" } };
	const tools = new Map();
	const sections = [];
	const contexts = [];
	const listeners = new Map();
	const ctx = {
		tools: {
			register(definition) {
				tools.set(definition.name, definition);
				return () => tools.delete(definition.name);
			},
			get(name) {
				return tools.get(name);
			},
		},
		systemPrompt: {
			section(section) {
				sections.push(section);
				return () => {};
			},
			context(context) {
				contexts.push(context);
				return () => {};
			},
		},
		agents: { roots: () => [rootAgent], list: () => [rootAgent, childAgent] },
		workingDirectory: { defaultDirectory: directory, get: () => directory },
		logger: { info() {}, warn() {} },
		on(event, listener) {
			listeners.set(event, [...(listeners.get(event) ?? []), listener]);
			return () => {};
		},
		off(event, listener) {
			listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
		},
		get() {
			return undefined;
		},
		effect() {},
	};
	return {
		ctx,
		rootAgent,
		childAgent,
		tools,
		sections,
		contexts,
		async fire(event, payload) {
			for (const listener of listeners.get(event) ?? []) await listener(payload);
		},
	};
}

test("the plugin registers project tools, a stable section and a warm context", async () => {
	const repo = makeRepo();
	const registry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-projects-reg-")), "projects.json");
	const h = fakeCtx(repo);
	const dispose = await apply(h.ctx, { registryPath: registry, skillRoot: path.join(repo, "missing-skill"), refreshSeconds: 3600 });
	try {
		assert.deepEqual([...h.tools.keys()].sort(), ["project_add", "project_list", "project_remove", "project_status", "project_warm"]);
		assert.equal(h.sections.length, 1);
		assert.equal(h.sections[0].name, "harness-projects");
		assert.equal(h.sections[0].order, 940);
		assert.equal(h.contexts.length, 1);
		assert.equal(h.contexts[0].name, "harness-projects");
		assert.equal(h.contexts[0].order, 130);
	} finally {
		dispose();
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(path.dirname(registry), { recursive: true, force: true });
	}
});

test("a root session is primed and auto-registered", async () => {
	const repo = makeRepo();
	const registry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-projects-reg-")), "projects.json");
	const h = fakeCtx(repo);
	const dispose = await apply(h.ctx, { registryPath: registry, skillRoot: path.join(repo, "missing-skill"), refreshSeconds: 3600 });
	try {
		await h.fire("agent/created", { agent: h.rootAgent });
		const section = h.sections[0].text({ agent: h.rootAgent });
		assert.match(section, /github\.com\/acme\/demo/);
		assert.match(section, /vault mode none/);
		const warm = h.contexts[0].text({ agent: h.rootAgent });
		assert.match(warm, /## Project context — github\.com\/acme\/demo/);
		assert.match(warm, /on main/);
		const saved = JSON.parse(fs.readFileSync(registry, "utf8"));
		assert.ok(Object.keys(saved.projects).length >= 1);
	} finally {
		dispose();
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(path.dirname(registry), { recursive: true, force: true });
	}
});

test("workers get no vault context and cannot call project tools", async () => {
	const repo = makeRepo();
	const registry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-projects-reg-")), "projects.json");
	const h = fakeCtx(repo);
	const dispose = await apply(h.ctx, { registryPath: registry, skillRoot: path.join(repo, "missing-skill"), refreshSeconds: 3600, warmForSubagents: false });
	try {
		await h.fire("agent/created", { agent: h.childAgent });
		assert.equal(h.contexts[0].text({ agent: h.childAgent }), "");
		const list = h.tools.get("project_list");
		await assert.rejects(() => list.execute({}, { agent: h.childAgent }), /orchestrator-only/);
	} finally {
		dispose();
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(path.dirname(registry), { recursive: true, force: true });
	}
});

test("project_add, project_list, project_status and project_remove work end to end", async () => {
	const repo = makeRepo();
	const registry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-projects-reg-")), "projects.json");
	const h = fakeCtx(repo);
	const dispose = await apply(h.ctx, { registryPath: registry, skillRoot: path.join(repo, "missing-skill"), refreshSeconds: 3600 });
	try {
		await h.fire("agent/created", { agent: h.rootAgent });
		const exec = { agent: h.rootAgent };
		const add = await h.tools.get("project_add").execute({ path: repo, name: "Demo" }, exec);
		assert.equal(add.code, 0);
		assert.match(add.stdout, /registered Demo/);

		const list = await h.tools.get("project_list").execute({}, exec);
		assert.match(list.stdout, /github\.com\/acme\/demo/);
		assert.match(list.stdout, /on main/);

		const status = await h.tools.get("project_status").execute({ path: repo }, exec);
		assert.equal(status.code, 0);
		assert.match(status.stdout, /first commit/);
		assert.match(status.stdout, /vault: none/);

		const warm = await h.tools.get("project_warm").execute({ path: repo }, exec);
		assert.match(warm.stdout, /Project context/);

		const remove = await h.tools.get("project_remove").execute({ path: repo }, exec);
		assert.equal(remove.code, 0);
		const again = await h.tools.get("project_remove").execute({ path: repo }, exec);
		assert.equal(again.code, 1);
	} finally {
		dispose();
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(path.dirname(registry), { recursive: true, force: true });
	}
});
