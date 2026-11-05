/** Test helper: copy the fake vault.mjs into a scratch skill root. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function makeSkillRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-vault-skill-"));
	const target = path.join(root, "vault.mjs");
	fs.copyFileSync(path.join(HERE, "fake-vault"), target);
	fs.chmodSync(target, 0o755);
	return { root, vaultMjs: target };
}

export function makeLog() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-vault-log-"));
	return { dir, file: path.join(dir, "calls.jsonl") };
}

export function readCalls(file) {
	try {
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}
