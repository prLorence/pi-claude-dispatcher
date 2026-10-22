/** Run with: node --test dispatch-plan/vault-config.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { configPull, configPush } from "./vault-config.mjs";

const dispatcherDir = path.resolve(import.meta.dirname, "..", "pi-plan-dispatch");
const load = (name) =>
	import(pathToFileURL(path.join(dispatcherDir, "vault", name)).href);
const notes = await load("notes.ts");
const git = await load("git.ts");
const privacy = await load("privacy.ts");

/** A temp repo, a temp vault and a temp HOME, all removed by cleanup. */
function setup() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vault-config-"));
	const home = path.join(base, "home");
	fs.mkdirSync(home);
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	return {
		root: path.join(base, "repo"),
		vault: path.join(base, "vault"),
		plans: path.join(base, "repo", ".plans"),
		cleanup() {
			process.env.HOME = previousHome;
			fs.rmSync(base, { recursive: true, force: true });
		},
	};
}

/** The hand-made context a function needs, with a fixed list of repos and one inside stub. */
function makeCall(t, { inside = () => true } = {}) {
	const out = [];
	const err = [];
	return {
		ctx: {
			vault: t.vault,
			root: t.root,
			modules: {
				notes: { readRepos: notes.readRepos },
				git: { scanSecrets: git.scanSecrets },
				privacy: { leaksNoneRepo: privacy.leaksNoneRepo },
			},
			out: (line) => out.push(line),
			err: (line) => err.push(line),
			inside,
		},
		out,
		err,
	};
}

function writeFile(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

function reposFile(t, repos) {
	writeFile(path.join(t.vault, "repos.json"), JSON.stringify({ repos, aliases: {} }));
}

function localConfig(t) {
	return path.join(t.plans, "config.json");
}

function vaultConfig(t) {
	return path.join(t.vault, "config", "dispatch.json");
}

const CONFIG =
	'{\n\t"autoReady": false,\n\t"roles": {\n\t\t"implement": { "model": "opencode-go/deepseek-v4.1-flash" }\n\t}\n}\n';

test("push stores the config text with exactly one trailing newline", () => {
	const t = setup();
	try {
		fs.mkdirSync(t.plans, { recursive: true });
		writeFile(localConfig(t), CONFIG);
		const { ctx, out, err } = makeCall(t);

		const result = configPush(ctx);

		assert.equal(result.code, 0, err.join("\n"));
		assert.deepEqual(out, ["config push: pushed"]);
		assert.deepEqual(err, []);
		assert.deepEqual(result.event, {
			kind: "vault.config",
			data: { op: "push", result: "pushed" },
		});
		assert.equal(fs.readFileSync(vaultConfig(t), "utf8"), CONFIG);
	} finally {
		t.cleanup();
	}
});

test("push gives a source without a newline just one", () => {
	const t = setup();
	try {
		fs.mkdirSync(t.plans, { recursive: true });
		writeFile(localConfig(t), '{"autoReady": false}');
		const { ctx } = makeCall(t);

		configPush(ctx);

		assert.equal(fs.readFileSync(vaultConfig(t), "utf8"), '{"autoReady": false}\n');
	} finally {
		t.cleanup();
	}
});

test("a second push of the same config is unchanged and rewrites nothing", () => {
	const t = setup();
	try {
		fs.mkdirSync(t.plans, { recursive: true });
		writeFile(localConfig(t), CONFIG);
		configPush(makeCall(t).ctx);
		const before = fs.statSync(vaultConfig(t)).mtimeMs;

		const { ctx, out } = makeCall(t);
		const result = configPush(ctx);

		assert.equal(result.code, 0);
		assert.deepEqual(out, ["config push: unchanged"]);
		assert.deepEqual(result.event, {
			kind: "vault.config",
			data: { op: "push", result: "unchanged" },
		});
		assert.equal(fs.statSync(vaultConfig(t)).mtimeMs, before);
	} finally {
		t.cleanup();
	}
});

test("push without a local config exits 1", () => {
	const t = setup();
	try {
		fs.mkdirSync(t.plans, { recursive: true });
		const { ctx, out, err } = makeCall(t);

		const result = configPush(ctx);

		assert.equal(result.code, 1);
		assert.deepEqual(out, []);
		assert.deepEqual(err, ["config push: .plans/config.json does not exist"]);
		assert.equal(result.event, undefined);
		assert.equal(fs.existsSync(path.join(t.vault, "config")), false);
	} finally {
		t.cleanup();
	}
});

test("push refuses an array, null and invalid JSON with exit 2", () => {
	const t = setup();
	try {
		fs.mkdirSync(t.plans, { recursive: true });
		for (const text of ["[]\n", "null\n", "{oops\n"]) {
			writeFile(localConfig(t), text);
			const { ctx, out, err } = makeCall(t);

			const result = configPush(ctx);

			assert.equal(result.code, 2, text);
			assert.deepEqual(out, [], text);
			assert.deepEqual(err, ["config push: not a JSON object"], text);
		}
		assert.equal(fs.existsSync(vaultConfig(t)), false);
	} finally {
		t.cleanup();
	}
});

test("push refuses a secret and names the pattern", () => {
	const t = setup();
	try {
		fs.mkdirSync(t.plans, { recursive: true });
		const token = "ghp" + "_" + "A".repeat(36);
		writeFile(localConfig(t), `{\n\t"model": "${token}"\n}\n`);
		const { ctx, out, err } = makeCall(t);

		const result = configPush(ctx);

		assert.equal(result.code, 2);
		assert.deepEqual(out, []);
		assert.deepEqual(err, ["config push: a secret pattern matched (github-token)"]);
		assert.equal(fs.existsSync(vaultConfig(t)), false);
	} finally {
		t.cleanup();
	}
});

test("push refuses a none-repo name and the message does not carry it", () => {
	const t = setup();
	try {
		reposFile(t, { "github.com/secret/none": { mode: "none" } });
		fs.mkdirSync(t.plans, { recursive: true });
		writeFile(localConfig(t), '{\n\t"note": "github.com/secret/none"\n}\n');
		const { ctx, out, err } = makeCall(t);

		const result = configPush(ctx);

		assert.equal(result.code, 2);
		assert.deepEqual(out, []);
		assert.deepEqual(err, ["config push: names a repo that is not allowed"]);
		const printed = [...out, ...err].join("\n");
		assert.equal(printed.includes("secret/none"), false);
		assert.equal(fs.existsSync(vaultConfig(t)), false);
	} finally {
		t.cleanup();
	}
});

test("push refuses a target outside the vault and writes nothing", () => {
	const t = setup();
	try {
		fs.mkdirSync(t.plans, { recursive: true });
		writeFile(localConfig(t), CONFIG);
		const { ctx, out, err } = makeCall(t, { inside: () => false });

		const result = configPush(ctx);

		assert.equal(result.code, 2);
		assert.deepEqual(out, []);
		assert.deepEqual(err, ["config push: refusing to write outside the vault"]);
		assert.equal(result.event, undefined);
		assert.equal(fs.existsSync(vaultConfig(t)), false);
	} finally {
		t.cleanup();
	}
});

test("pull writes the vault config into an empty .plans", () => {
	const t = setup();
	try {
		writeFile(vaultConfig(t), CONFIG);
		fs.mkdirSync(t.plans, { recursive: true });
		const { ctx, out, err } = makeCall(t);

		const result = configPull(ctx, { force: false });

		assert.equal(result.code, 0, err.join("\n"));
		assert.deepEqual(out, ["config pull: pulled"]);
		assert.deepEqual(err, []);
		assert.deepEqual(result.event, {
			kind: "vault.config",
			data: { op: "pull", result: "pulled" },
		});
		assert.equal(fs.readFileSync(localConfig(t), "utf8"), CONFIG);
	} finally {
		t.cleanup();
	}
});

test("pull keeps an existing local file without force and replaces it with force", () => {
	const t = setup();
	try {
		writeFile(vaultConfig(t), CONFIG);
		fs.mkdirSync(t.plans, { recursive: true });
		writeFile(localConfig(t), '{"autoReady": true}\n');

		const kept = makeCall(t);
		const first = configPull(kept.ctx, { force: false });

		assert.equal(first.code, 0);
		assert.deepEqual(kept.out, ["config pull: kept the local file (use --force to replace it)"]);
		assert.deepEqual(first.event, {
			kind: "vault.config",
			data: { op: "pull", result: "kept" },
		});
		assert.equal(fs.readFileSync(localConfig(t), "utf8"), '{"autoReady": true}\n');

		const forced = makeCall(t);
		const second = configPull(forced.ctx, { force: true });

		assert.equal(second.code, 0);
		assert.deepEqual(forced.out, ["config pull: pulled"]);
		assert.equal(fs.readFileSync(localConfig(t), "utf8"), CONFIG);
	} finally {
		t.cleanup();
	}
});

test("pull without a vault config exits 1", () => {
	const t = setup();
	try {
		fs.mkdirSync(t.plans, { recursive: true });
		const { ctx, out, err } = makeCall(t);

		const result = configPull(ctx, { force: true });

		assert.equal(result.code, 1);
		assert.deepEqual(out, []);
		assert.deepEqual(err, ["config pull: no dispatch config in the vault"]);
		assert.equal(result.event, undefined);
		assert.equal(fs.existsSync(localConfig(t)), false);
	} finally {
		t.cleanup();
	}
});

test("pull without a .plans folder exits 1", () => {
	const t = setup();
	try {
		writeFile(vaultConfig(t), CONFIG);
		const { ctx, out, err } = makeCall(t);

		const result = configPull(ctx, { force: false });

		assert.equal(result.code, 1);
		assert.deepEqual(out, []);
		assert.deepEqual(err, ["config pull: .plans does not exist"]);
		assert.equal(fs.existsSync(localConfig(t)), false);
	} finally {
		t.cleanup();
	}
});
