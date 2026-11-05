/** Keep the `.plans/` skeleton present in every managed git repository. */
import * as fs from "node:fs";
import * as path from "node:path";

export const PLAN_DIRS = ["inbox", "running", "done", "failed", "specs", "decisions", "traces", "sessions"];

export function ensurePlanDirs(root) {
	const plans = path.join(root, ".plans");
	const created = !fs.existsSync(plans);
	for (const name of PLAN_DIRS) fs.mkdirSync(path.join(plans, name), { recursive: true });
	return { root, plans, created, dirs: PLAN_DIRS.map((name) => path.join(plans, name)) };
}
