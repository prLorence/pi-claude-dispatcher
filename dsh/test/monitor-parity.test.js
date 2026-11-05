import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readState } from "../plugins/harness-monitor/state.js";
import { sessionPage } from "../plugins/harness-monitor/server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const TESTDATA = path.join(ROOT, "monitor-app", "testdata");
const manifest = JSON.parse(fs.readFileSync(path.join(TESTDATA, "manifest.json"), "utf8"));

function materialize(c, root) {
	for (const rel of c.dirs ?? []) fs.mkdirSync(path.join(root, rel), { recursive: true });
	const source = path.join(TESTDATA, "trees", c.name);
	const walk = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const from = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(from);
			else {
				const rel = path.relative(TESTDATA, from);
				const to = path.join(root, rel);
				fs.mkdirSync(path.dirname(to), { recursive: true });
				fs.copyFileSync(from, to);
			}
		}
	};
	walk(source);
	const keys = Object.keys(manifest.mtimes ?? {}).sort((a, b) => {
		const da = a.split("/").length;
		const db = b.split("/").length;
		return da === db ? a.localeCompare(b) : db - da;
	});
	for (const rel of keys) {
		const abs = path.join(root, rel);
		if (!fs.existsSync(abs)) continue;
		const when = new Date(manifest.mtimes[rel]);
		fs.utimesSync(abs, when, when);
	}
	for (const rel of Object.keys(c.modes ?? {})) {
		try {
			fs.chmodSync(path.join(root, rel), c.modes[rel]);
		} catch {}
	}
}

function restoreModes(dir) {
	try {
		fs.chmodSync(dir, 0o755);
	} catch {}
	let entries = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) if (entry.isDirectory()) restoreModes(path.join(dir, entry.name));
}

function strip(value) {
	if (Array.isArray(value)) return value.map(strip);
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			if (k === "code") continue;
			out[k] = strip(v);
		}
		return out;
	}
	return value;
}

for (const c of manifest.cases) {
	test(`golden parity: ${c.name}`, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-monitor-parity-"));
		try {
			materialize(c, root);
			const repos = c.repos.map((r) => ({ name: r.name, dir: path.join(root, r.dir) }));
			const got = readState(repos, manifest.nowMs, c.message ?? null);
			const want = JSON.parse(fs.readFileSync(path.join(TESTDATA, c.state), "utf8"));
			assert.deepEqual(strip(got), want);
			for (const s of c.sessions ?? []) {
				const repo = repos.find((r) => r.name === s.repo);
				const res = sessionPage(repo.dir, s.plan, s.id, s.after, manifest.nowMs);
				assert.equal(res.status, 200);
				const page = JSON.parse(res.body);
				const golden = JSON.parse(fs.readFileSync(path.join(TESTDATA, s.golden), "utf8"));
				assert.deepEqual(strip(page), golden);
			}
		} finally {
			restoreModes(root);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
