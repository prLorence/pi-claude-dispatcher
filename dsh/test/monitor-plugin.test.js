import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { apply, relativeStaticPath } from "../plugins/harness-monitor/index.js";

/** Mount the plugin, then read `/api/state` through the registered handler. */
async function mount(config) {
	const routes = [];
	const logs = [];
	const ctx = {
		workingDirectory: { defaultDirectory: process.cwd() },
		logger: { info: (message) => logs.push(message) },
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			},
		},
	};
	const dispose = await apply(ctx, config);
	const stateRoute = routes.find((route) => route.path === "/api/state");
	const body = await new Promise((resolve) => {
		stateRoute.handler({ method: "GET", headers: { host: "127.0.0.1" }, url: "/api/state" }, {
			writeHead() {},
			end(value) {
				resolve(String(value));
			},
		});
	});
	return { routes, logs, state: JSON.parse(body), dispose };
}

/** A temp registry plus the project directories named in it. */
function registryFixture(projects) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-monitor-registry-"));
	const entries = {};
	for (const project of projects) {
		const dir = path.join(base, project.key);
		fs.mkdirSync(dir, { recursive: true });
		if (project.plans !== false) fs.mkdirSync(path.join(dir, ".plans"));
		entries[dir] = { path: dir, name: project.name, pinned: project.pinned ?? false };
	}
	const registryPath = path.join(base, "harness-projects.json");
	fs.writeFileSync(registryPath, JSON.stringify({ version: 1, projects: entries }));
	return { base, registryPath };
}

test("the monitor plugin registers only read routes on webServer", async () => {
	const routes = [];
	const ctx = {
		workingDirectory: { defaultDirectory: process.cwd() },
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			},
		},
	};
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-monitor-plugin-"));
	try {
		const dispose = await apply(ctx, { root, plansDir: path.join(root, ".plans"), registryPath: path.join(root, "absent.json") });
		assert.deepEqual(
			routes.map((r) => `${r.kind} ${r.path}`),
			[
				"exact /api/state",
				"exact /api/events",
				"prefix /api/monitor/session",
				"exact /api/agents",
				"prefix /plugins/harness-monitor",
			],
		);
		assert.equal(typeof dispose, "function");
		dispose();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("static assets work whether the mount prefix was stripped or not", () => {
	const prefix = "/plugins/harness-monitor";
	assert.equal(relativeStaticPath(prefix, `${prefix}/index-abc.js`), "/index-abc.js");
	assert.equal(relativeStaticPath(prefix, "/index-abc.js"), "/index-abc.js");
	assert.equal(relativeStaticPath(prefix, `${prefix}/`), "/index.html");
	assert.equal(relativeStaticPath(prefix, "/"), "/index.html");
});

test("discovery reads projects with a .plans folder from the registry", async () => {
	const fixture = registryFixture([
		{ key: "repo-b", name: "repo-b" },
		{ key: "repo-a", name: "repo-a" },
	]);
	try {
		const mounted = await mount({ root: fixture.base, registryPath: fixture.registryPath });
		try {
			assert.deepEqual(
				mounted.state.repos.map((repo) => repo.name),
				["repo-a", "repo-b"],
			);
			assert.deepEqual(
				mounted.state.repos.map((repo) => repo.message),
				["No plan has run yet", "No plan has run yet"],
			);
			assert.equal(mounted.logs.length, 1);
			assert.match(mounted.logs[0], /harness-monitor: watching 2 projects from .*harness-projects\.json/);
		} finally {
			mounted.dispose();
		}
	} finally {
		fs.rmSync(fixture.base, { recursive: true, force: true });
	}
});

test("discovery ignores a registered project without a .plans folder", async () => {
	const fixture = registryFixture([
		{ key: "has-plans", name: "has-plans" },
		{ key: "no-plans", name: "no-plans", plans: false },
	]);
	try {
		const mounted = await mount({ root: fixture.base, registryPath: fixture.registryPath });
		try {
			assert.deepEqual(
				mounted.state.repos.map((repo) => repo.name),
				["has-plans"],
			);
		} finally {
			mounted.dispose();
		}
	} finally {
		fs.rmSync(fixture.base, { recursive: true, force: true });
	}
});

test("explicit config.repos wins over the registry", async () => {
	const fixture = registryFixture([{ key: "registered", name: "registered" }]);
	try {
		const explicit = [{ name: "chosen", dir: path.join(fixture.base, "elsewhere", ".plans") }];
		const mounted = await mount({ root: fixture.base, registryPath: fixture.registryPath, repos: explicit });
		try {
			assert.deepEqual(
				mounted.state.repos.map((repo) => repo.name),
				["chosen"],
			);
			assert.equal(mounted.logs.length, 0);
		} finally {
			mounted.dispose();
		}
	} finally {
		fs.rmSync(fixture.base, { recursive: true, force: true });
	}
});

test("a missing registry falls back to the single repo", async () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-monitor-missing-registry-"));
	try {
		const mounted = await mount({ root: base, registryPath: path.join(base, "absent.json"), repoName: "solo" });
		try {
			assert.deepEqual(
				mounted.state.repos.map((repo) => repo.name),
				["solo"],
			);
			assert.equal(mounted.state.repos[0].message, "No plans folder found");
			assert.equal(mounted.logs.length, 0);
		} finally {
			mounted.dispose();
		}
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});
