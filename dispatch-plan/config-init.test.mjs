/** Run with: node --test dispatch-plan/config-init.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const cli = path.join(import.meta.dirname, "config-init.mjs");
const dispatcher = path.resolve(import.meta.dirname, "..", "pi-plan-dispatch");
const core = await import(pathToFileURL(path.join(dispatcher, "core.ts")).href);

/** A temp repo and an empty temp HOME, so nothing comes from this machine. */
function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-init-root-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-init-home-"));
	return { root, home };
}

/** Run the CLI with HOME redirected and PI_PLAN_DISPATCH_DIR unset unless the test sets it. */
function run(ctx, args, extraEnv = {}) {
	const env = { ...process.env, HOME: ctx.home };
	delete env.PI_PLAN_DISPATCH_DIR;
	Object.assign(env, extraEnv);
	const r = spawnSync(process.execPath, [cli, ...args], { cwd: ctx.root, env, encoding: "utf8" });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const realDispatcher = { PI_PLAN_DISPATCH_DIR: dispatcher };

const plansDir = (ctx) => path.join(ctx.root, ".plans");
const configPath = (ctx) => path.join(plansDir(ctx), "config.json");

/** The same config the dispatcher gets when there is no config file. */
function defaults(ctx) {
	return core.loadConfig({ root: path.join(ctx.root, "no-config") });
}

/** loadConfig spreads the whole file, so the orchestrator-only key is dropped before comparing. */
function withoutAutoReady(cfg) {
	const copy = { ...cfg };
	delete copy.autoReady;
	return copy;
}

function loadWritten(ctx) {
	return core.loadConfig(core.getDirs(ctx.root));
}

test("full output has every default key, no prompts, and loads to the defaults", () => {
	const ctx = setup();
	const r = run(ctx, [], realDispatcher);
	assert.equal(r.status, 0, r.stdout + r.stderr);

	const text = fs.readFileSync(configPath(ctx), "utf8");
	assert.ok(text.endsWith("\n"), "file ends with a newline");
	assert.equal(text.includes('"prompt"'), false, "no role prompts in the file");

	const written = JSON.parse(text);
	const expectedKeys = [...Object.keys(core.DEFAULT_CONFIG), "autoReady"].sort();
	assert.deepEqual(Object.keys(written).sort(), expectedKeys);
	assert.equal(written.autoReady, false);
	assert.deepEqual(written.roles.implement, {});
	assert.deepEqual(written.roles.review, {
		model: core.DEFAULT_ROLES.review.model,
		thinking: core.DEFAULT_ROLES.review.thinking,
		readonly: true,
	});
	assert.deepEqual(written.roles.qa, {
		model: core.DEFAULT_ROLES.qa.model,
		thinking: core.DEFAULT_ROLES.qa.thinking,
	});
	assert.deepEqual(withoutAutoReady(loadWritten(ctx)), defaults(ctx));

	const wrote = r.stdout.split("\n").find((line) => line.startsWith("wrote "));
	assert.ok(wrote, r.stdout);
	assert.equal(fs.realpathSync(wrote.slice("wrote ".length).trim()), fs.realpathSync(configPath(ctx)));
	assert.ok(r.stdout.includes("roles.review.model"), r.stdout);
	assert.ok(r.stdout.includes("/plans roles test"), r.stdout);
});

test("--minimal writes only the review role and autoReady", () => {
	const ctx = setup();
	const r = run(ctx, ["--minimal"], realDispatcher);
	assert.equal(r.status, 0, r.stdout + r.stderr);

	const written = JSON.parse(fs.readFileSync(configPath(ctx), "utf8"));
	assert.deepEqual(written, {
		autoReady: false,
		roles: {
			review: {
				model: core.DEFAULT_ROLES.review.model,
				thinking: core.DEFAULT_ROLES.review.thinking,
			},
		},
	});
	assert.deepEqual(withoutAutoReady(loadWritten(ctx)), defaults(ctx));
});

test("a second run exits 1 and leaves the file byte for byte", () => {
	const ctx = setup();
	assert.equal(run(ctx, [], realDispatcher).status, 0);
	const before = fs.readFileSync(configPath(ctx), "utf8");

	const r = run(ctx, [], realDispatcher);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.ok(r.stderr.includes("config.json"), r.stderr);
	assert.ok(r.stderr.includes("already exists"), r.stderr);
	assert.ok(r.stderr.includes("--force"), r.stderr);
	assert.equal(fs.readFileSync(configPath(ctx), "utf8"), before);
	assert.deepEqual(fs.readdirSync(plansDir(ctx)), ["config.json"]);
});

test("--force copies the old file to one .bak- file and rewrites", () => {
	const ctx = setup();
	assert.equal(run(ctx, [], realDispatcher).status, 0);
	const before = fs.readFileSync(configPath(ctx), "utf8");

	const r = run(ctx, ["--minimal", "--force"], realDispatcher);
	assert.equal(r.status, 0, r.stdout + r.stderr);

	const entries = fs.readdirSync(plansDir(ctx)).sort();
	const backups = entries.filter((name) => name.startsWith("config.json.bak-"));
	assert.equal(backups.length, 1, entries.join(", "));
	assert.deepEqual(entries, [...backups, "config.json"].sort());
	assert.equal(fs.readFileSync(path.join(plansDir(ctx), backups[0]), "utf8"), before);
	const rewritten = JSON.parse(fs.readFileSync(configPath(ctx), "utf8"));
	assert.deepEqual(Object.keys(rewritten.roles), ["review"]);
	assert.equal(r.stderr.includes("backup: "), true, r.stderr);
});

test("--print writes nothing and ignores an existing file", () => {
	const ctx = setup();
	const r = run(ctx, ["--print"], realDispatcher);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(fs.existsSync(plansDir(ctx)), false);
	const printed = JSON.parse(r.stdout);
	assert.deepEqual(Object.keys(printed).sort(), [...Object.keys(core.DEFAULT_CONFIG), "autoReady"].sort());
	assert.equal(r.stdout.trimEnd().endsWith("}"), true);

	fs.mkdirSync(plansDir(ctx), { recursive: true });
	fs.writeFileSync(configPath(ctx), '{"dryRun": true}\n');
	const again = run(ctx, ["--print", "--minimal"], realDispatcher);
	assert.equal(again.status, 0, again.stdout + again.stderr);
	assert.deepEqual(Object.keys(JSON.parse(again.stdout).roles), ["review"]);
	assert.equal(fs.readFileSync(configPath(ctx), "utf8"), '{"dryRun": true}\n');
});

test("--root points at another repo", () => {
	const ctx = setup();
	const other = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-init-other-"));
	const r = spawnSync(process.execPath, [cli, "--root", other], {
		cwd: ctx.home,
		env: { ...process.env, HOME: ctx.home, PI_PLAN_DISPATCH_DIR: dispatcher },
		encoding: "utf8",
	});
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(fs.existsSync(path.join(other, ".plans", "config.json")), true);
	assert.equal(fs.existsSync(plansDir(ctx)), false);
});

test("no dispatcher modules exits 2 and says where it looked", () => {
	const ctx = setup();
	const r = run(ctx, []);
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.equal(r.stdout, "");
	assert.ok(r.stderr.includes("cannot find the pi-plan-dispatch modules"), r.stderr);
	assert.ok(r.stderr.includes(path.join(ctx.root, "pi-plan-dispatch")), r.stderr);
	assert.ok(r.stderr.includes(path.join(ctx.home, ".pi", "agent", "extensions", "pi-plan-dispatch")), r.stderr);
	assert.equal(fs.existsSync(plansDir(ctx)), false);
});

test("an unknown option exits 64 with the usage", () => {
	const ctx = setup();
	const r = run(ctx, ["--bogus"], realDispatcher);
	assert.equal(r.status, 64, r.stdout + r.stderr);
	assert.ok(r.stderr.includes("unknown option: --bogus"), r.stderr);
	assert.ok(r.stderr.includes("usage: node config-init.mjs"), r.stderr);
	assert.equal(fs.existsSync(plansDir(ctx)), false);
});

test("--root without a directory exits 64", () => {
	const ctx = setup();
	const r = run(ctx, ["--root"], realDispatcher);
	assert.equal(r.status, 64, r.stdout + r.stderr);
	assert.ok(r.stderr.includes("--root needs a directory"), r.stderr);
});
