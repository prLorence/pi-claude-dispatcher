import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, parseModels } from "../plugins/harness-dispatcher-ui/index.js";

// ---------------------------------------------------------------------------
// parseModels: the real `omp --list-models` output is two tables. The
// Canonical models table is the one with canonical/selected/variants/context/
// max-out; the Provider models table must never leak into the result.
// ---------------------------------------------------------------------------

const OMP_LIST_MODELS = `Canonical models
canonical                   selected                                variants  context  max-out
anthropic/claude-3-opus     anthropic/claude-3-opus-20240229        1         200K     4.1K   
claude-3-5-haiku            anthropic/claude-3-5-haiku-latest       2         200K     8.2K   
claude-opus-4-6             anthropic/claude-opus-4-6               1         1M       128K   
deepseek-v4-1-flash         opencode-go/deepseek-v4.1-flash         1         222K     8.9K   
anthropic/claude-3-opus     anthropic/claude-3-opus-20240229        1         200K     4.1K   
fable-latest                ~anthropic/claude-fable-latest          1         1M       128K   
local-only                  local-only                              1         128K     8K    

Provider models
provider     model                       context  max-out  thinking                       images
anthropic    claude-haiku-4-5            200K     64K      minimal,low,medium,high,xhigh  yes   
opencode-go  kimi-k2.5                   262K     66K      minimal,low,medium,high,xhigh  yes   

`;

test("parseModels reads the canonical table, skips headers, dedupes and keeps only ids with a slash", () => {
	const models = parseModels(OMP_LIST_MODELS);
	const ids = models.map((m) => m.id);

	assert.deepEqual(new Set(ids), new Set([
		"anthropic/claude-3-opus-20240229",
		"anthropic/claude-3-5-haiku-latest",
		"anthropic/claude-opus-4-6",
		"opencode-go/deepseek-v4.1-flash",
		"~anthropic/claude-fable-latest",
	]));
	assert.equal(models.length, 5, "duplicate canonical rows collapse and provider rows/no-slash ids are dropped");
	assert.equal(ids.includes("selected"), false, "the column header is not a model");
	assert.equal(ids.includes("claude-haiku-4-5"), false, "Provider models rows are not canonical ids");
	assert.equal(ids.includes("local-only"), false, "ids without a slash are dropped");
	assert.equal(ids.filter((id) => id === "anthropic/claude-3-opus-20240229").length, 1);

	const deepseek = models.find((m) => m.id === "opencode-go/deepseek-v4.1-flash");
	assert.deepEqual(deepseek, {
		id: "opencode-go/deepseek-v4.1-flash",
		provider: "opencode-go",
		canonical: "deepseek-v4-1-flash",
		context: "222K",
		maxOut: "8.9K",
		variants: "1",
	});

	const alias = models.find((m) => m.id === "~anthropic/claude-fable-latest");
	assert.equal(alias.canonical, "fable-latest");
	assert.equal(alias.provider, "~anthropic");
	assert.equal(alias.context, "1M");
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

test("apply registers the two exact routes and returns a disposer", async () => {
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
	]);
	assert.equal(typeof dispose, "function");
	dispose();
	assert.equal(disposed, 2);
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
