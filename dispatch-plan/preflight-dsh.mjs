/**
 * Adapter that presents the dsh dispatcher plugin's modules through the same
 * `core` / `verify` interface `preflight.mjs` reads from pi-plan-dispatch.
 *
 * The two dispatchers are separate implementations of one format: the plan
 * parser, the preflight rules and the verify helpers were ported, so the
 * preflight CLI can load either one. Only the entry points the CLI calls are
 * mapped here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** The plugin files that must exist for a directory to be a dsh dispatcher. */
const PLUGIN_FILES = ["plan.js", "preflight.js", "config.js", "roles.js", "verify.js"];

/** Relative to a repository root: the dsh plugin that implements the format. */
export const PLUGIN_PATH = path.join("dsh", "plugins", "harness-dispatch");

/** True when `dir` holds a dsh dispatcher plugin rather than a pi one. */
export function isPluginDir(dir) {
	return PLUGIN_FILES.every((file) => fs.existsSync(path.join(dir, file)));
}

const importFile = (file) => import(pathToFileURL(file).href);

/**
 * Load the plugin modules and reshape them into the pi `core` / `verify` pair.
 *
 * pi keeps `parsePlan`, `preflightPlan`, `getDirs`, `loadConfig` and
 * `applyPairDefault` in one `core.ts`; dsh splits them across `plan.js`,
 * `preflight.js`, `config.js` and `roles.js`. Gathering them under the same
 * names lets `preflight.mjs` run either dispatcher without a branch per call.
 */
export async function loadDispatcherPlugin(dir) {
	const [plan, preflight, config, roles, verify] = await Promise.all(
		PLUGIN_FILES.map((file) => importFile(path.join(dir, file))),
	);

	return {
		core: {
			PlanParseError: plan.PlanParseError,
			parsePlan: plan.parsePlan,
			preflightPlan: preflight.preflightPlan,
			getDirs: config.getDirs,
			loadConfig: config.loadConfig,
			applyPairDefault: roles.applyPairDefault,
		},
		verify: {
			commandExists: verify.commandExists,
			VERIFY_OUTPUT_TAIL: verify.VERIFY_OUTPUT_TAIL,
		},
	};
}
