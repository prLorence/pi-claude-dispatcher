import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, parseModels } from "../plugins/harness-dispatcher-ui/index.js";

// ---------------------------------------------------------------------------
// parseModels: the real `omp --list-models` output is two tables with different
// columns. Both are usable ids: a Provider row's `<provider>/<model>` is exactly
// what `--model` takes. Parsing only Canonical hid most of the catalog — a
// custom provider with 13 models in models.yml surfaced as 2 aliases.
// ---------------------------------------------------------------------------

const OMP_LIST_MODELS = `Canonical models
canonical                   selected                                variants  context  max-out
anthropic/claude-3-opus     anthropic/claude-3-opus-20240229        1         200K     4.1K   
claude-3-5-haiku            anthropic/claude-3-5-haiku-latest       2         200K     8.2K   
deepseek-v4-1-flash         opencode-go/deepseek-v4.1-flash         1         222K     8.9K   
anthropic/claude-3-opus     anthropic/claude-3-opus-20240229        1         200K     4.1K   
fable-latest                ~anthropic/claude-fable-latest          1         1M       128K   
local-only                  local-only                              1         128K     8K    

Provider models
provider          model                       context  max-out  thinking                       images
anthropic         claude-haiku-4-5            200K     64K      minimal,low,medium,high,xhigh  yes   
opencode-go       kimi-k2.5                   262K     66K      minimal,low,medium,high,xhigh  yes   
opendesign-cloud  deepseek-v4.1-flash         1M       128K     minimal,low,medium,high,xhigh  yes   
opendesign-cloud  claude-haiku-5.5            1M       128K     -                              yes   

`;

test("parseModels keeps both tables, since a provider row is a valid --model id", () => {
	const models = parseModels(OMP_LIST_MODELS);
	const ids = models.map((m) => m.id);

	// Canonical aliases the picker already used.
	for (const id of [
		"anthropic/claude-3-opus-20240229",
		"anthropic/claude-3-5-haiku-latest",
		"opencode-go/deepseek-v4.1-flash",
		"~anthropic/claude-fable-latest",
	]) {
		assert.ok(ids.includes(id), `${id} survives`);
	}
	// Provider rows the old parser dropped.
	for (const id of [
		"anthropic/claude-haiku-4-5",
		"opencode-go/kimi-k2.5",
		"opendesign-cloud/deepseek-v4.1-flash",
		"opendesign-cloud/claude-haiku-5.5",
	]) {
		assert.ok(ids.includes(id), `${id} is reachable as a model`);
	}

	assert.equal(ids.includes("selected"), false, "the column header is not a model");
	assert.equal(ids.includes("provider"), false, "the provider header is not a model");
	assert.equal(ids.includes("local-only"), false, "ids without a slash are dropped");
	assert.equal(ids.filter((id) => id === "anthropic/claude-3-opus-20240229").length, 1, "duplicates collapse");

	const deepseek = models.find((m) => m.id === "opencode-go/deepseek-v4.1-flash");
	assert.equal(deepseek.provider, "opencode-go");
	assert.equal(deepseek.context, "222K");
	assert.equal(deepseek.maxOut, "8.9K");

	const alias = models.find((m) => m.id === "~anthropic/claude-fable-latest");
	assert.equal(alias.canonical, "fable-latest");
	assert.equal(alias.provider, "~anthropic");
	assert.equal(alias.context, "1M");

	// Provider rows carry their own columns, not the canonical ones.
	const od = models.find((m) => m.id === "opendesign-cloud/deepseek-v4.1-flash");
	assert.equal(od.provider, "opendesign-cloud");
	assert.equal(od.context, "1M");
	assert.equal(od.maxOut, "128K");
	assert.match(od.thinking, /minimal,low/);
	assert.equal(od.images, "yes");
});

test("parseModels records every model of a custom provider", () => {
	// Regression: a provider defined only in models.yml used to surface as the
	// couple of canonical aliases that happened to reference it.
	const rows = [
		["claude-haiku-5.5", "1M", "128K", "-", "yes"],
		["deepseek-v4-flash", "1M", "32K", "minimal,low,medium,high,xhigh", "no"],
		["deepseek-v4-pro", "1M", "128K", "minimal,low,medium,high,xhigh", "no"],
		["glm-5.3-flash", "1M", "32K", "minimal,low,medium,high,xhigh", "yes"],
		["gpt-6-luna", "1.1M", "128K", "-", "yes"],
	];
	const out = [
		"Canonical models",
		"canonical   selected   variants  context  max-out",
		"glm-5.3-flashx   opendesign-cloud/glm-5.3-flashx   1   1M   32K",
		"",
		"Provider models",
		"provider          model             context  max-out  thinking                       images",
		...rows.map((r) => `opendesign-cloud  ${r[0]}  ${r[1]}  ${r[2]}  ${r[3]}  ${r[4]}`),
	].join("\n");

	const models = parseModels(out);
	const od = models.filter((m) => m.provider === "opendesign-cloud");
	assert.equal(od.length, 6, "five provider rows plus the canonical alias");
	assert.ok(od.every((m) => m.id.startsWith("opendesign-cloud/")));
});

test("parseModels tolerates empty output", () => {
	assert.deepEqual(parseModels(""), []);
	assert.deepEqual(parseModels("\n \n"), []);
});

// ---------------------------------------------------------------------------
// Client registration: DOM-free, with a stubbed module loader and React.
// ---------------------------------------------------------------------------

const loaded = [];
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			loaded.push(definition);
		},
	},
};

await import("../plugins/harness-dispatcher-ui/client.js");

function fakeReact() {
	return {
		createElement(type, props, ...children) {
			return { type, props: props ?? {}, children };
		},
		useState(initial) {
			return [typeof initial === "function" ? initial() : initial, () => {}];
		},
		useEffect() {},
		useCallback(fn) {
			return fn;
		},
	};
}

function loadClient() {
	const definition = loaded[0];
	assert.ok(definition, "the client module registered a loader definition");
	assert.equal(definition.id, "@pi-harness/dsh-plugin-harness-dispatcher-ui");
	const react = fakeReact();
	const client = definition.factory((id) => {
		assert.equal(id, "react");
		return react;
	});
	return { client, React: react };
}

function mount(client) {
	const registrations = [];
	const ctx = {
		slots: {
			inject(slot, register) {
				registrations.push({ slot, value: register() });
				return () => {};
			},
			register(options, Component) {
				return { options, Component };
			},
		},
	};
	client.apply(ctx);
	return registrations;
}

test("the dispatcher client registers the main panel and the sidebar panellist", () => {
	const { client } = loadClient();
	assert.deepEqual(client.inject, ["slots"]);

	const registrations = mount(client);
	assert.equal(registrations.length, 2);
	assert.deepEqual(registrations.map((r) => r.slot), ["main", "sidebar.panellist"]);

	const main = registrations.find((r) => r.slot === "main");
	assert.equal(main.value.options.name, "main");
	assert.equal(main.value.options.key, "dispatcher");
	assert.equal(typeof main.value.Component, "function");

	const sidebar = registrations.find((r) => r.slot === "sidebar.panellist");
	assert.equal(sidebar.value.options.name, "sidebar.panellist");
	assert.equal(sidebar.value.options.id, "dispatcher");
	assert.equal(sidebar.value.options.order, 30);
	const label = typeof sidebar.value.options.label === "function" ? sidebar.value.options.label() : sidebar.value.options.label;
	assert.equal(label, "Dispatcher");
	assert.equal(typeof sidebar.value.Component, "function");
});

test("DispatcherPanel renders with no data instead of throwing", () => {
	const { client } = loadClient();
	const registrations = mount(client);
	const panel = registrations.find((r) => r.slot === "main").value.Component;
	const tree = panel();
	assert.equal(tree.type, "div");
	assert.equal(tree.props.className, "dp-root");
});

// ---------------------------------------------------------------------------
// Host contract: exact routes, disposer, and the save path against a fake
// `omp` executable (never the real one, so no model call and no config write).
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "dispatcher-ui-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const MODELS_FILE = join(dir, "models.txt");
const ROLES_FILE = join(dir, "roles.json");
const ROLES_NOW_FILE = join(dir, "roles-now.json");
const SET_FILE = join(dir, "set.json");
const FAKE_OMP = join(dir, "fake-omp");

writeFileSync(MODELS_FILE, `Canonical models
canonical                   selected                                variants  context  max-out
claude-opus-4-6             anthropic/claude-opus-4-6               1         1M       128K   
fable-latest                ~anthropic/claude-fable-latest          1         1M       128K   
deepseek-v4-1-flash         opencode-go/deepseek-v4.1-flash         1         222K     8.9K   
`);
writeFileSync(ROLES_FILE, JSON.stringify({ default: "anthropic/claude-opus-4-6:high", smol: "opencode-go/glm-5", slow: "opencode-go/kimi-k2.4" }));
writeFileSync(
	FAKE_OMP,
	`#!/bin/sh
d="${dir}"
case "$1 $2" in
  "--list-models ") cat "$d/models.txt" ;;
  "config get")
    if [ -f "$d/roles-now.json" ]; then v=$(cat "$d/roles-now.json"); else v=$(cat "$d/roles.json"); fi
    printf '{"key":"modelRoles","value":%s,"type":"record","description":""}\\n' "$v" ;;
  "config set")
    printf '%s' "$4" > "$d/roles-now.json"
    printf '%s' "$4" > "$d/set.json" ;;
  *) echo "unexpected omp invocation: $*" >&2; exit 1 ;;
esac
`,
);
chmodSync(FAKE_OMP, 0o755);

function fakeResponse() {
	return {
		status: 0,
		headers: {},
		body: undefined,
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers ?? {};
		},
		end(value) {
			this.body = value === undefined ? undefined : JSON.parse(value);
		},
	};
}

function fakeRequest(method, body) {
	return {
		method,
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) yield Buffer.from(JSON.stringify(body));
		},
	};
}

test("apply registers the exact routes and returns a disposer that removes all of them", async () => {
	const routes = [];
	let disposed = 0;
	const ctx = {
		webServer: {
			register(route) {
				routes.push(route);
				return () => {
					disposed += 1;
				};
			},
		},
	};
	const dispose = await apply(ctx, { ompCommand: FAKE_OMP });
	assert.deepEqual(routes.map((r) => `${r.kind} ${r.path}`), [
		"exact /plugins/harness-dispatcher/settings",
		"exact /plugins/harness-dispatcher/models",
		"exact /plugins/harness-dispatcher/roles",
	]);
	assert.equal(typeof dispose, "function");
	dispose();
	assert.equal(disposed, 3);
});

test("the models and settings routes reject wrong methods without running omp", async () => {
	const routes = [];
	const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
	await apply(ctx, { ompCommand: FAKE_OMP });
	const settings = routes.find((r) => r.path.endsWith("/settings"));
	const models = routes.find((r) => r.path.endsWith("/models"));

	const settingsRes = fakeResponse();
	await settings.handler(fakeRequest("DELETE"), settingsRes);
	assert.equal(settingsRes.status, 405);
	assert.equal(settingsRes.headers.allow, "GET, HEAD, POST");

	const modelsRes = fakeResponse();
	await models.handler(fakeRequest("PUT"), modelsRes);
	assert.equal(modelsRes.status, 405);
	assert.equal(modelsRes.headers.allow, "GET, HEAD");
});

test("GET /models serves the catalog including tilde-prefixed alias ids", async () => {
	const routes = [];
	const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
	await apply(ctx, { ompCommand: FAKE_OMP });
	const models = routes.find((r) => r.path.endsWith("/models"));
	const res = fakeResponse();
	await models.handler(fakeRequest("GET"), res);
	assert.equal(res.status, 200);
	assert.deepEqual(new Set(res.body.models.map((m) => m.id)), new Set([
		"anthropic/claude-opus-4-6",
		"opencode-go/deepseek-v4.1-flash",
		"~anthropic/claude-fable-latest",
	]));
	assert.match(res.body.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("POST /settings saves a tilde id and preserves the other model roles", async () => {
	rmSync(ROLES_NOW_FILE, { force: true });
	rmSync(SET_FILE, { force: true });
	const routes = [];
	const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
	await apply(ctx, { ompCommand: FAKE_OMP });
	const settings = routes.find((r) => r.path.endsWith("/settings"));

	const res = fakeResponse();
	await settings.handler(fakeRequest("POST", { ompModel: "~anthropic/claude-fable-latest" }), res);
	assert.equal(res.status, 200);
	assert.equal(res.body.ompModel, "~anthropic/claude-fable-latest");

	const written = JSON.parse(readFileSync(SET_FILE, "utf8"));
	assert.equal(written.default, "~anthropic/claude-fable-latest");
	assert.equal(written.smol, "opencode-go/glm-5", "existing smol role survives the save");
	assert.equal(written.slow, "opencode-go/kimi-k2.4", "existing slow role survives the save");
});

test("POST /settings accepts a thinking suffix on a catalog id", async () => {
	rmSync(ROLES_NOW_FILE, { force: true });
	const routes = [];
	const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
	await apply(ctx, { ompCommand: FAKE_OMP });
	const settings = routes.find((r) => r.path.endsWith("/settings"));

	const res = fakeResponse();
	await settings.handler(fakeRequest("POST", { ompModel: "anthropic/claude-opus-4-6:high" }), res);
	assert.equal(res.status, 200);
	assert.equal(JSON.parse(readFileSync(SET_FILE, "utf8")).default, "anthropic/claude-opus-4-6:high");
});

test("POST /settings rejects an invalid id without writing modelRoles", async () => {
	rmSync(ROLES_NOW_FILE, { force: true });
	rmSync(SET_FILE, { force: true });
	const routes = [];
	const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
	await apply(ctx, { ompCommand: FAKE_OMP });
	const settings = routes.find((r) => r.path.endsWith("/settings"));

	const res = fakeResponse();
	await settings.handler(fakeRequest("POST", { ompModel: "not a model" }), res);
	assert.equal(res.status, 400);
	assert.match(res.body.error, /invalid omp model id/);
	assert.equal(existsSync(SET_FILE), false, "no config set happened");
});

// ---------------------------------------------------------------------------
// Roles route: dispatcher role overrides for one registered repository.
// ---------------------------------------------------------------------------

function rolesCtx(projects) {
	const routes = [];
	const registry = join(dir, "projects.json");
	writeFileSync(registry, JSON.stringify({ version: 1, projects }));
	return {
		routes,
		registry,
		ctx: {
			webServer: {
				register(route) {
					routes.push(route);
					return () => {};
				},
			},
		},
	};
}

function rolesRoute(handle) {
	return handle.routes.find((r) => r.path === "/plugins/harness-dispatcher/roles");
}

test("GET /roles lists projects and the built-in defaults for the first one", async () => {
	const repo = mkdtempSync(join(tmpdir(), "roles-ui-repo-"));
	mkdirSync(join(repo, ".plans"), { recursive: true });
	const handle = rolesCtx({ [repo]: { path: repo, name: "demo" } });
	await apply(handle.ctx, { ompCommand: FAKE_OMP, projectRegistry: join(dir, "projects.json") });
	const res = fakeResponse();
	await rolesRoute(handle).handler({ method: "GET", url: "/plugins/harness-dispatcher/roles" }, res);
	assert.equal(res.status, 200);
	assert.equal(res.body.root, repo);
	assert.deepEqual(res.body.projects, [repo]);
	assert.deepEqual(
		res.body.roles.map((r) => r.name),
		["implement-omp", "pair-omp", "pair-omp-contributor"],
	);
	assert.ok(res.body.roles.every((r) => r.overridden === false));
	rmSync(repo, { recursive: true, force: true });
});

test("POST /roles writes an override and GET reflects it", async () => {
	const repo = mkdtempSync(join(tmpdir(), "roles-ui-repo-"));
	mkdirSync(join(repo, ".plans"), { recursive: true });
	const handle = rolesCtx({ [repo]: { path: repo, name: "demo" } });
	await apply(handle.ctx, { ompCommand: FAKE_OMP, projectRegistry: join(dir, "projects.json") });

	const post = fakeResponse();
	await rolesRoute(handle).handler(
		fakeRequest("POST", { root: repo, role: "implement-omp", model: "opencode-go/deepseek-v4.1-flash" }),
		post,
	);
	assert.equal(post.status, 200, JSON.stringify(post.body));
	assert.equal(post.body.role.model, "opencode-go/deepseek-v4.1-flash");
	assert.equal(post.body.role.overridden, true);

	const res = fakeResponse();
	await rolesRoute(handle).handler({ method: "GET", url: "/plugins/harness-dispatcher/roles" }, res);
	const role = res.body.roles.find((r) => r.name === "implement-omp");
	assert.equal(role.model, "opencode-go/deepseek-v4.1-flash");
	assert.equal(role.overridden, true);
	rmSync(repo, { recursive: true, force: true });
});

test("POST /roles rejects an unregistered root, a bad role and an off-catalog model", async () => {
	const repo = mkdtempSync(join(tmpdir(), "roles-ui-repo-"));
	mkdirSync(join(repo, ".plans"), { recursive: true });
	const handle = rolesCtx({ [repo]: { path: repo, name: "demo" } });
	await apply(handle.ctx, { ompCommand: FAKE_OMP, projectRegistry: join(dir, "projects.json") });
	const route = rolesRoute(handle);

	for (const [body, pattern] of [
		[{ root: "/tmp/not-registered", role: "implement-omp", model: "" }, /not a registered project/],
		[{ root: repo, role: "nope", model: "" }, /not an omp role/],
		[{ root: repo, role: "implement-omp", model: "not/a/real/model" }, /not in the omp catalog/],
		[{ root: "relative/path", role: "implement-omp", model: "" }, /absolute repository path/],
	]) {
		const res = fakeResponse();
		await route.handler(fakeRequest("POST", body), res);
		assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
		assert.match(res.body.error, pattern);
	}
	// Nothing was written by any rejected request.
	assert.equal(existsSync(join(repo, ".plans", "config.json")), false);
	rmSync(repo, { recursive: true, force: true });
});

test("POST /roles with a null model or thinking resets instead of writing the text \"null\"", async () => {
	const repo = mkdtempSync(join(tmpdir(), "roles-ui-repo-"));
	mkdirSync(join(repo, ".plans"), { recursive: true });
	const handle = rolesCtx({ [repo]: { path: repo, name: "demo" } });
	await apply(handle.ctx, { ompCommand: FAKE_OMP, projectRegistry: join(dir, "projects.json") });
	const route = rolesRoute(handle);

	const first = fakeResponse();
	await route.handler(
		fakeRequest("POST", { root: repo, role: "pair-omp", model: "opencode-go/deepseek-v4.1-flash", thinking: "high" }),
		first,
	);
	assert.equal(first.status, 200);

	for (const body of [
		{ root: repo, role: "pair-omp", thinking: null },
		{ root: repo, role: "pair-omp", model: null },
	]) {
		const res = fakeResponse();
		await route.handler(fakeRequest("POST", body), res);
		assert.equal(res.status, 200, JSON.stringify(res.body));
	}

	const written = JSON.parse(readFileSync(join(repo, ".plans", "config.json"), "utf8"));
	assert.equal(written.roles, undefined, `config must not keep a "null" string: ${JSON.stringify(written.roles)}`);
	rmSync(repo, { recursive: true, force: true });
});
