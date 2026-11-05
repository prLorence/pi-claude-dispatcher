/**
 * Host half of the Dispatcher panel: read the omp model catalog, read/write
 * omp's default model, and serve the panel. It never reads a model key.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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



/** Parse `omp --list-models` into selected model ids. */
export function parseModels(stdout) {
	const seen = new Set();
	const models = [];
	for (const line of String(stdout).split("\n")) {
		if (!line.trim() || /^canonical\s/i.test(line.trim())) continue;
		const cols = line.trim().split(/\s{2,}/);
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

	return () => {
		settingsRoute?.();
		modelsRoute?.();
	};
}

export default { name, inject, apply };
