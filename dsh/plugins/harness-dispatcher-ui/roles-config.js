/**
 * Read and write dispatch role overrides in one repository's `.plans/config.json`.
 *
 * The dispatcher resolves a role as built-in defaults merged with whatever the
 * repository's config says, so a role is only ever "set" here as an override.
 * Writing preserves every other key in the file, including the decider block and
 * keys this plugin does not know about.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_ROLES } from "../harness-dispatch/roles.js";

/** The roles that can be pointed at omp, in the order the panel shows them. */
export const OMP_ROLES = ["implement-omp", "pair-omp", "pair-omp-contributor"];

export function configPath(root) {
	return path.join(root, ".plans", "config.json");
}

function readRaw(root) {
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath(root), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** One role's effective settings: the repo override sitting on the built-in. */
export function describeRole(root, name) {
	const raw = readRaw(root);
	const over = raw?.roles?.[name] && typeof raw.roles[name] === "object" ? raw.roles[name] : {};
	const base = DEFAULT_ROLES[name] ?? {};
	return {
		name,
		agent: over.agent ?? base.agent ?? "dsh",
		model: over.model ?? base.model ?? "",
		thinking: over.thinking ?? base.thinking ?? "",
		readonly: Boolean(over.readonly ?? base.readonly),
		overridden: Object.keys(over).length > 0,
		override: over,
	};
}

export function readRoles(root) {
	return OMP_ROLES.map((name) => describeRole(root, name));
}

/**
 * Merge `patch` into the role's override. A null value deletes that key, which
 * is how the panel restores a built-in without inventing a second file format.
 */
export function writeRole(root, name, patch) {
	if (!OMP_ROLES.includes(name)) throw new Error(`not an omp role: ${name}`);
	const file = configPath(root);
	const raw = readRaw(root);
	const roles = raw.roles && typeof raw.roles === "object" && !Array.isArray(raw.roles) ? { ...raw.roles } : {};
	const current = roles[name] && typeof roles[name] === "object" ? { ...roles[name] } : {};
	for (const [key, value] of Object.entries(patch ?? {})) {
		if (value === null || value === undefined) delete current[key];
		else current[key] = value;
	}
	if (Object.keys(current).length > 0) roles[name] = current;
	else delete roles[name];
	if (Object.keys(roles).length > 0) raw.roles = roles;
	else delete raw.roles;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
	return describeRole(root, name);
}

/** Whether a model id is safe to write. Catalog membership is checked separately. */
export function validModelId(id) {
	return typeof id === "string" && id.length > 0 && id.length <= 200 && /^[^\s"'`\\]+$/.test(id);
}
