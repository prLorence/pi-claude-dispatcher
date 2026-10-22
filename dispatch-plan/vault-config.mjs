/**
 * `config push` and `config pull`: the one copy of `.plans/config.json` that
 * travels through the vault. The file holds model names only, so the repo
 * privacy modes do not apply to it, but a secret or a `none` repo name still
 * stops a push.
 *
 * Plain ESM with Node built-ins only. The pure checks come in through the
 * `modules` object the caller passes, and both functions return
 * `{ code, event? }` after printing one line per call.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const CONFIG_FILE = path.join(".plans", "config.json");
const VAULT_FILE = path.join("config", "dispatch.json");
const DECODER = new TextDecoder("utf-8", { fatal: true });

/** A file as strict UTF-8 text, or undefined when it cannot be read or is not text. */
function readUtf8(file) {
	try {
		const text = DECODER.decode(fs.readFileSync(file));
		return text.includes("\u0000") ? undefined : text;
	} catch {
		return undefined;
	}
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(text) {
	try {
		const parsed = JSON.parse(text);
		return isObject(parsed);
	} catch {
		return false;
	}
}

/** The one trailing newline both files get, whatever the source had. */
function normalized(text) {
	return `${text.replace(/\n+$/u, "")}\n`;
}

/** Write through a temp file and a rename, so a crash never leaves half a file. */
function writeAtomic(target, text) {
	const tmp = `${target}.tmp`;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, target);
}

function sameBytes(target, text) {
	try {
		return fs.readFileSync(target, "utf8") === text;
	} catch {
		return false;
	}
}

function pushEvent(result) {
	return { kind: "vault.config", data: { op: "push", result } };
}

function pullEvent(result) {
	return { kind: "vault.config", data: { op: "pull", result } };
}

export function configPush(c) {
	const source = path.join(c.root, CONFIG_FILE);
	if (!fs.existsSync(source)) {
		c.err("config push: .plans/config.json does not exist");
		return { code: 1 };
	}
	const text = readUtf8(source);
	if (text === undefined || !parseObject(text)) {
		c.err("config push: not a JSON object");
		return { code: 2 };
	}
	const repos = c.modules.notes.readRepos(c.vault);
	const secrets = c.modules.git.scanSecrets(text);
	if (secrets.length > 0) {
		c.err(`config push: a secret pattern matched (${secrets.join(", ")})`);
		return { code: 2 };
	}
	if (c.modules.privacy.leaksNoneRepo(repos, text).length > 0) {
		c.err("config push: names a repo that is not allowed");
		return { code: 2 };
	}
	const target = path.join(c.vault, VAULT_FILE);
	if (!c.inside(target)) {
		c.err("config push: refusing to write outside the vault");
		return { code: 2 };
	}
	const stored = normalized(text);
	const result = sameBytes(target, stored) ? "unchanged" : "pushed";
	if (result === "pushed") writeAtomic(target, stored);
	c.out(`config push: ${result}`);
	return { code: 0, event: pushEvent(result) };
}

export function configPull(c, { force } = {}) {
	const source = path.join(c.vault, VAULT_FILE);
	if (!fs.existsSync(source)) {
		c.err("config pull: no dispatch config in the vault");
		return { code: 1 };
	}
	let text;
	try {
		text = fs.readFileSync(source, "utf8");
	} catch {
		c.err("config pull: no dispatch config in the vault");
		return { code: 1 };
	}
	const plansDir = path.join(c.root, ".plans");
	if (!fs.existsSync(plansDir) || !fs.statSync(plansDir).isDirectory()) {
		c.err("config pull: .plans does not exist");
		return { code: 1 };
	}
	const target = path.join(c.root, CONFIG_FILE);
	if (fs.existsSync(target) && force !== true) {
		c.out("config pull: kept the local file (use --force to replace it)");
		return { code: 0, event: pullEvent("kept") };
	}
	writeAtomic(target, normalized(text));
	c.out("config pull: pulled");
	return { code: 0, event: pullEvent("pulled") };
}
