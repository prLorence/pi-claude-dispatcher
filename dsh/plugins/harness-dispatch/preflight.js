/** G4 preflight: reject an unsafe or oversized plan before any worker starts. */
import * as fs from "node:fs";
import * as path from "node:path";
import { agentProblem, knownRoles, pairDefaultProblem, resolveRole } from "./roles.js";

/** True when `target` is `root` or lies below it, both already resolved. */
function insideRepo(root, target) {
	return target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/**
 * Follow symlinks in the deepest part of `target` that exists and append the
 * parts that do not exist yet, then say whether the result is outside `root`.
 */
function escapesRepo(root, target) {
	let base = target;
	const rest = [];
	for (;;) {
		try {
			return !insideRepo(root, path.join(fs.realpathSync(base), ...rest));
		} catch {
			const parent = path.dirname(base);
			if (parent === base) return true;
			rest.unshift(path.basename(base));
			base = parent;
		}
	}
}

export function preflightPlan(plan, cfg, cwd) {
	const errors = [];
	const badPairDefault = pairDefaultProblem(cfg);
	if (badPairDefault !== undefined) errors.push(badPairDefault);
	const agentRoles = [];
	const noteAgentRole = (name) => {
		if (!name || agentRoles.includes(name) || !knownRoles(cfg).includes(name)) return;
		agentRoles.push(name);
	};
	if (cfg.pairDefault !== "") noteAgentRole(cfg.pairDefault);
	for (const task of plan.tasks) {
		noteAgentRole(task.role || "implement");
		if (task.pair) noteAgentRole(task.pair);
	}
	for (const name of agentRoles) {
		const problem = agentProblem(cfg, name);
		if (problem !== undefined) errors.push(problem);
	}
	const names = knownRoles(cfg).join(", ");
	let repo;
	if (cwd !== undefined) {
		try {
			repo = fs.realpathSync(cwd);
		} catch {
			repo = undefined;
		}
	}
	for (const task of plan.tasks) {
		const roleName = task.role || "implement";
		if (!knownRoles(cfg).includes(roleName)) {
			errors.push(`Task ${task.id}: unknown role "${roleName}" (known roles: ${names})`);
		} else if (roleName !== "security" && resolveRole(cfg, roleName).readonly) {
			errors.push(
				`Task ${task.id}: role "${roleName}" is read-only; read-only roles other than "security" can only be used as pair: reviewers`,
			);
		}
		if (task.pair) {
			if (!knownRoles(cfg).includes(task.pair)) {
				errors.push(`Task ${task.id}: unknown pair role "${task.pair}" (known roles: ${names})`);
			} else if (resolveRole(cfg, roleName).readonly) {
				errors.push(`Task ${task.id}: role "${roleName}" is read-only, so it cannot be paired with "${task.pair}"`);
			} else if (!resolveRole(cfg, task.pair).readonly) {
				errors.push(`Task ${task.id}: pair role "${task.pair}" is not read-only; a pair reviewer must be a read-only role`);
			}
		}
		if (task.pairSource !== "none" && task.pairRounds !== undefined && !(task.pairRounds >= 1 && task.pairRounds <= 3)) {
			errors.push(`Task ${task.id}: pair_rounds must be 1 to 3, got ${task.pairRounds}`);
		}
		for (const entry of task.files) {
			const raw = entry.trim();
			const rel = raw.replace(/\\/g, "/").replace(/^\.\//, "");
			const segments = rel.split("/");
			const first = segments[0].toLowerCase();
			if (path.isAbsolute(raw)) {
				errors.push(`Task ${task.id}: files entry "${raw}" is absolute; use a path relative to the repo root`);
			} else if (raw.startsWith("~") || raw.startsWith("@")) {
				errors.push(`Task ${task.id}: files entry "${raw}" uses a ~ or @ prefix, which a worker tool would resolve elsewhere; use a path relative to the repo root`);
			} else if (raw.includes("://")) {
				errors.push(`Task ${task.id}: files entry "${raw}" is a URL; use a path relative to the repo root`);
			} else if (segments.includes("..")) {
				errors.push(`Task ${task.id}: files entry "${raw}" contains ".."; it must stay inside the repo`);
			} else if (first === ".git") {
				errors.push(`Task ${task.id}: files entry "${raw}" is inside .git/, which no worker may touch`);
			} else if (first === ".plans") {
				errors.push(`Task ${task.id}: files entry "${raw}" is inside .plans/, which the planner owns`);
			} else if (repo !== undefined && escapesRepo(repo, path.resolve(cwd, rel))) {
				errors.push(`Task ${task.id}: files entry "${raw}" leaves the repo through a symlink`);
			}
		}
		if (task.files.length > cfg.maxFilesPerTask) {
			errors.push(`Task ${task.id}: ${task.files.length} files listed (max ${cfg.maxFilesPerTask}); split it into smaller tasks`);
		}
		if (task.body.length > cfg.maxTaskChars) {
			errors.push(`Task ${task.id}: body is ${task.body.length} chars (max ${cfg.maxTaskChars}); split it into smaller tasks`);
		}
	}
	return errors;
}
