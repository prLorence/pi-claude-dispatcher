/**
 * Host half of the Dispatcher panel: read the omp model catalog, read/write
 * omp's default model, and serve the panel. It never reads a model key.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { OMP_ROLES, readRoles, validModelId, writeRole } from "./roles-config.js";

const run = promisify(execFile);
const PREFIX = "/plugins/harness-dispatcher";
// Any catalog id omp may print, including alias ids such as
// "~anthropic/claude-fable-latest", and an optional ":<thinking>" suffix.
// Whitespace, quotes and backslashes are the only hard no; exact catalog
// membership in the save path is the real validation.
const MODEL_RE = /^[^\s"'`\\]+$/;

export const name = "harness-dispatcher-ui";
export const inject = ["webServer"];

function ompCommand(config) {
	return config?.ompCommand || "omp";
}



/**
 * Parse `omp --list-models` into canonical model ids.
 *
 * The output is two tables. Only the Canonical table maps a short alias to the
 * id omp accepts, so parsing stops at the Provider table header: those rows put
 * a bare model name in the same column, and ids such as
 * `openrouter/meta/muse-spark-1.3` contain a slash, which would otherwise be
 * accepted as a canonical id and flood the picker with unrunnable entries.
 */
export function parseModels(stdout) {
	const seen = new Set();
	const models = [];
	for (const line of String(stdout).split("\n")) {
		const trimmed = line.trim();
		if (/^Provider models$/i.test(trimmed)) break;
		if (!trimmed || /^canonical\s/i.test(trimmed)) continue;
		const cols = trimmed.split(/\s{2,}/);
		if (cols.length < 4) continue;
		const [canonical, selected, variants, context, maxOut] = cols;
		if (!selected || !selected.includes("/")) continue;
		if (seen.has(selected)) continue;
		seen.add(selected);
		models.push({ id: selected, provider: selected.slice(0, selected.indexOf("/")), canonical, context: context || "", maxOut: maxOut || "", variants: variants || "" });
	}
	return models.sort((a, b) => a.id.localeCompare(b.id));
}

async function readBody(req, limit = 64 * 1024) {
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (body.length > limit) throw new Error("request body too large");
	}
	if (!body.trim()) return {};
	try {
		return JSON.parse(body);
	} catch {
		throw new Error("invalid JSON body");
	}
}

function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}

export async function apply(ctx, config = {}) {
	const command = ompCommand(config);
	const omp = async (args, timeout = 20_000) => {
		const { stdout } = await run(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
		return stdout;
	};
	let modelCache;
	let modelCacheAt = 0;
	const models = async () => {
		if (modelCache && Date.now() - modelCacheAt < 60_000) return modelCache;
		modelCache = parseModels(await omp(["--list-models", ""]));
		modelCacheAt = Date.now();
		return modelCache;
	};
	const modelRoles = async () => {
		const out = await omp(["config", "get", "modelRoles", "--json"]);
		const parsed = JSON.parse(out);
		const value = parsed?.value;
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	};
	const defaultModel = async () => {
		const roles = await modelRoles();
		return typeof roles.default === "string" ? roles.default : "";
	};

	/** The model list, or empty when omp is unavailable: the panel still renders. */
	const safeModels = async () => {
		try {
			return await models();
		} catch {
			return [];
		}
	};

	/** Registered project roots, which is where a .plans/config.json can live. */
	const projectRoots = () => {
		const file = config.projectRegistry || path.join(os.homedir(), ".dsh", "harness-projects.json");
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
			const projects = parsed?.projects ?? {};
			return Object.values(projects)
				.map((entry) => (typeof entry?.path === "string" ? entry.path : ""))
				.filter(Boolean)
				.sort();
		} catch {
			return [];
		}
	};
	const firstProjectRoot = () => projectRoots()[0] ?? "";

	const settingsRoute = ctx.webServer.register({
		kind: "exact",
		path: `${PREFIX}/settings`,
		handler: async (req, res) => {
			if (req.method === "GET" || req.method === "HEAD") {
				try {
					json(res, 200, { ompModel: await defaultModel(), models: await models() });
				} catch (error) {
					json(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405, { allow: "GET, HEAD, POST" });
				res.end();
				return;
			}
			try {
				const body = await readBody(req);
				const model = typeof body.ompModel === "string" ? body.ompModel.trim() : "";
				if (!model || !MODEL_RE.test(model)) throw new Error("invalid omp model id");
				const available = await models();
				const base = model.includes(":") ? model.slice(0, model.lastIndexOf(":")) : model;
				const inCatalog = (id) => available.some((entry) => entry.id === id);
				if (available.length && !inCatalog(model) && !inCatalog(base)) {
					throw new Error(`model is not in the omp catalog: ${model}`);
				}
				// `omp config set` replaces a record wholesale, so merge the new
				// default into the roles that already exist (smol/slow/plan/...).
				const roles = await modelRoles();
				await omp(["config", "set", "modelRoles", JSON.stringify({ ...roles, default: model }), "--json"]);
				json(res, 200, { ompModel: await defaultModel(), models: available });
			} catch (error) {
				json(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		},
	});

	const modelsRoute = ctx.webServer.register({
		kind: "exact",
		path: `${PREFIX}/models`,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { allow: "GET, HEAD" });
				res.end();
				return;
			}
			try {
				json(res, 200, { models: await models(), updatedAt: new Date().toISOString() });
			} catch (error) {
				json(res, 500, { error: error instanceof Error ? error.message : String(error), models: [] });
			}
		},
	});

	// Dispatcher roles live in each repository's .plans/config.json, so the panel
	// needs a repository to talk about. Reuse the projects registry rather than
	// asking the operator to retype a path.
	const rolesRoute = ctx.webServer.register({
		kind: "exact",
		path: `${PREFIX}/roles`,
		handler: async (req, res) => {
			if (req.method === "GET" || req.method === "HEAD") {
				try {
					const url = new URL(req.url ?? "/", "http://localhost");
					const root = url.searchParams.get("root") || firstProjectRoot();
					if (!root) {
						json(res, 200, { root: "", projects: projectRoots(), roles: [], models: await safeModels() });
						return;
					}
					json(res, 200, { root, projects: projectRoots(), roles: readRoles(root), models: await safeModels() });
				} catch (error) {
					json(res, 400, { error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405, { allow: "GET, HEAD, POST" });
				res.end();
				return;
			}
			try {
				const body = await readBody(req);
				const root = typeof body.root === "string" ? body.root.trim() : "";
				const role = typeof body.role === "string" ? body.role.trim() : "";
				if (!root || !path.isAbsolute(root)) throw new Error("root must be an absolute repository path");
				if (!projectRoots().includes(root)) throw new Error("root is not a registered project");
				if (!OMP_ROLES.includes(role)) throw new Error(`not an omp role: ${role}`);
				const patch = {};
				// null is how the panel resets a key to the built-in. Without the
				// explicit check, String(null) writes the literal text "null".
				const text = (value) => (value === null ? null : String(value).trim());
				if (body.model !== undefined) {
					const model = text(body.model);
					if (model !== null && model !== "" && !validModelId(model)) throw new Error("invalid model id");
					const base = model && model.includes(":") ? model.slice(0, model.lastIndexOf(":")) : model;
					const available = await safeModels();
					if (model && available.length > 0 && !available.some((m) => m.id === model || m.id === base)) {
						throw new Error(`model is not in the omp catalog: ${model}`);
					}
					patch.model = model === "" || model === null ? null : model;
				}
				if (body.thinking !== undefined) {
					const thinking = text(body.thinking);
					patch.thinking = thinking === "" || thinking === null ? null : thinking;
				}
				json(res, 200, { root, role: writeRole(root, role, patch), roles: readRoles(root) });
			} catch (error) {
				json(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		},
	});

	return () => {
		settingsRoute?.();
		modelsRoute?.();
		rolesRoute?.();
	};
}

export default { name, inject, apply };
