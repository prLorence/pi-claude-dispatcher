/**
 * The orchestrator's project tools. They read git and the vault; the only write
 * is the plugin's own registry file. Nothing here writes a vault file.
 */
import { describeGit, truncate } from "./git-parse.js";
import { canonicalPath, listProjects, removeProject, saveRegistry, upsertProject } from "./registry.js";
import { sortFindings, sortRecent, projectFor } from "./vault-notes.js";

const S = (description) => ({ type: "string", description });
const B = (description) => ({ type: "boolean", description });

function toolDef(name, description, parameters, execute) {
	return {
		name,
		description,
		parameters: { type: "object", properties: parameters, additionalProperties: false },
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: [value.stdout?.trim(), value.stderr?.trim(), value.code === 0 ? "" : `exit ${value.code ?? "timeout"}`].filter(Boolean).join("\n") || "(no output)" }],
		},
		async execute(args, exec) {
			return execute(args ?? {}, exec);
		},
	};
}

/** The compact one-repo brief used by `project_status` and the warm block. */
export function repoBrief(repo) {
	const lines = [`${repo.slug ?? "(no remote)"}`, `path: ${repo.root ?? repo.path}`, `git: ${describeGit(repo.git)}`];
	const commits = repo.git?.commits ?? [];
	if (commits.length) {
		lines.push("commits:");
		for (const commit of commits.slice(0, 5)) lines.push(`- ${commit.short} ${commit.subject} — ${commit.author}, ${commit.date}`);
	}
	return lines.join("\n");
}

export function registerProjectTools(ctx, { getState, warmText, warmFor, isRoot, defaultDir, maxRepos = 80 } = {}) {
	const guard = (exec, write = false) => {
		if (!isRoot(exec?.agent)) throw new Error("project tools are orchestrator-only; subagents and workers have no project or vault access");
		if (write && !isRoot(exec?.agent)) throw new Error("only the orchestrator changes the project registry");
	};

	const dir = (args, exec) => args.path || defaultDir(exec?.agent);

	const defs = [
		toolDef(
			"project_list",
			"List the managed git repositories: slug, branch, dirt, ahead/behind and the newest commit. Read-only.",
			{ refresh: B("Re-read git state instead of the cached copy") },
			async (args, exec) => {
				guard(exec);
				const { registry } = getState();
				const projects = listProjects(registry).slice(0, maxRepos);
				if (!projects.length) return { code: 0, stdout: "No projects registered yet. Run project_add with a repo path, or start a session inside a git repository." };
				const rows = [];
				for (const project of projects) {
					const { repo } = await warmFor(project.path, { force: Boolean(args.refresh) });
					rows.push(`${project.pinned ? "* " : "- "}${repo?.slug ?? project.slug ?? project.name} (${project.path})\n  ${describeGit(repo?.git)}`);
				}
				return { code: 0, stdout: rows.join("\n") };
			},
		),
		toolDef(
			"project_add",
			"Manage a local git repository as a project: register its path, name and vault slug. Defaults to the session's repository root.",
			{ path: S("Directory inside the repository; defaults to the session directory"), name: S("Display name; defaults to the directory name"), slug: S("Vault repo slug; derived from origin when omitted"), pinned: B("Keep it at the top of project_list") },
			async (args, exec) => {
				guard(exec, true);
				const { registry, save, ensurePlans } = getState();
				const { repo } = await warmFor(dir(args, exec));
				if (!repo?.root) return { code: 1, stdout: "", stderr: `${dir(args, exec)} is not inside a git repository` };
				const record = upsertProject(registry, { path: repo.root, name: args.name, slug: args.slug || repo.slug, pinned: args.pinned });
				ensurePlans?.(repo.root);
				save();
				return { code: 0, stdout: `registered ${record.name} (${record.path}) as ${record.slug ?? "local"}` };
			},
		),
		toolDef(
			"project_remove",
			"Stop managing a repository. It stays on disk; only the registry entry goes.",
			{ path: S("Repository path; defaults to the session directory") },
			async (args, exec) => {
				guard(exec, true);
				const { registry, save, ensurePlans } = getState();
				const target = canonicalPath(dir(args, exec));
				const removed = removeProject(registry, target);
				if (removed) save();
				return { code: removed ? 0 : 1, stdout: removed ? `removed ${target}` : "", stderr: removed ? "" : `${target} is not in the registry` };
			},
		),
		toolDef(
			"project_status",
			"One project in detail: git state and commits, vault mode, project note, open findings, recent runs and the newest log lines. Read-only.",
			{ path: S("Repository path; defaults to the session directory"), findings: { type: "number", description: "Open findings to show (default 5)" } },
			async (args, exec) => {
				guard(exec);
				const { reader } = getState();
				const { repo } = await warmFor(dir(args, exec), { force: true });
				if (!repo?.root) return { code: 1, stdout: "", stderr: `${dir(args, exec)} is not inside a git repository` };
				const mode = await reader.modeOf(repo.slug);
				const out = [repoBrief(repo), `vault: ${mode}`];
				if (mode !== "none") {
					const snapshot = await reader.snapshot();
					const notes = snapshot.notes;
					if (notes) {
						const matches = (note) => note.repo === repo.slug || note.repos?.includes(repo.slug);
						const project = projectFor(notes.projects, repo.slug);
						if (project) out.push("", `project note [[${project.basename}]]`, truncate(project.body, 800));
						const findings = sortFindings(notes.findings.filter((note) => matches(note) && note.status !== "closed"), Math.max(1, Math.min(20, Number(args.findings) || 5)));
						if (findings.length) {
							out.push("", `open findings (${findings.length}):`);
							for (const note of findings) out.push(`- [${note.severity ?? "info"}] ${note.basename}: ${truncate(note.title, 160)}`);
						}
						const runs = sortRecent(notes.runs.filter(matches), 3);
						if (runs.length) {
							out.push("", "recent runs:");
							for (const note of runs) out.push(`- ${note.basename}: gate ${note.gate ?? "?"}, ${note.status ?? "?"} (${note.updated})`);
						}
					}
				}
				return { code: 0, stdout: out.join("\n") };
			},
		),
		toolDef(
			"project_warm",
			"Rebuild the warm context for the current session's repository and return the exact text the model receives.",
			{ path: S("Repository path; defaults to the session directory") },
			async (args, exec) => {
				guard(exec);
				const target = dir(args, exec);
				await warmFor(target, { force: true });
				return { code: 0, stdout: warmText(target) || `(no warm context for ${target})` };
			},
		),
	];

	const disposers = defs.map((definition) => ctx.tools.register(definition));
	return () => {
		for (const dispose of disposers) dispose?.();
	};
}

export { saveRegistry, upsertProject };
