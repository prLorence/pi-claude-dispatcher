/**
 * The orchestrator's vault tools. Every one shells out to vault.mjs through the
 * allow-listed CLI; none writes a vault file itself.
 */
import { recordRun } from "./record.js";
import { slug } from "./naming.js";

const S = (description) => ({ type: "string", description });
const B = (description) => ({ type: "boolean", description });

function common(root) {
	return {
		trace: S("Trace id; passed as --trace when set"),
		root: S(`Repo root; defaults to ${root}`),
	};
}

function appendRoot(args, out, fallback) {
	const root = args.root || fallback;
	if (root) out.push("--root", root);
	return out;
}

function appendTrace(args, out) {
	if (args.trace) out.push("--trace", args.trace);
	return out;
}

/** Build the argv for each vault tool. Pure, so tests can check it. */
export function buildVaultArgs(tool, args = {}, root) {
	const out = [];
	if (tool === "vault_search") {
		out.push("search", String(args.query ?? ""));
		if (args.repo) out.push("--repo", args.repo);
		if (args.all) out.push("--all");
		if (args.status) out.push("--status", args.status);
		if (args.include_work) out.push("--include-work");
		if (args.limit) out.push("--limit", String(args.limit));
		if (args.json) out.push("--json");
		appendTrace(args, out);
		appendRoot(args, out, root);
		return out;
	}
	if (tool === "vault_note") {
		const sub = String(args.subcommand ?? "");
		out.push("note", sub);
		if (sub === "new") {
			out.push(String(args.type ?? ""), String(args.basename ?? ""));
		} else if (sub === "status") {
			out.push(String(args.basename ?? ""), String(args.status ?? ""));
		} else if (sub === "supersede") {
			out.push(String(args.old ?? ""), String(args.new ?? ""));
		} else if (sub === "set") {
			out.push(String(args.basename ?? ""));
		} else {
			out.push("__bad__");
		}
		for (const pair of args.sets ?? []) {
			const eq = pair.indexOf("=");
			if (eq > 0) out.push("--set", pair);
		}
		if (args.body !== undefined) out.push("--body-stdin");
		appendTrace(args, out);
		appendRoot(args, out, root);
		return out;
	}
	if (tool === "vault_work") {
		const action = String(args.action ?? "pending");
		out.push("work", action);
		if (args.trace) out.push("--trace", args.trace);
		if (args.probes) out.push("--probes");
		appendRoot(args, out, root);
		return out;
	}
	if (tool === "vault_log") {
		out.push("log", "append", "--repo", String(args.repo ?? "-"));
		appendTrace(args, out);
		if (args.text) out.push(String(args.text));
		appendRoot(args, out, root);
		return out;
	}
	if (tool === "vault_sync") {
		out.push("sync", String(args.action ?? "pull"));
		appendTrace(args, out);
		appendRoot(args, out, root);
		return out;
	}
	if (tool === "vault_restore") {
		out.push("restore");
		appendRoot(args, out, root);
		return out;
	}
	if (tool === "vault_config") {
		out.push("config", String(args.action ?? "push"));
		if (args.force) out.push("--force");
		appendRoot(args, out, root);
		return out;
	}
	throw new Error(`unknown vault tool: ${tool}`);
}


/** Build the standard product-to-deployment pipeline body for a project note. */
export function projectBody(args = {}) {
	const lines = [`# ${args.name ?? args.basename ?? "Project"}`, "", "## Pipeline"];
	const stage = (label, values) => {
		const list = (Array.isArray(values) ? values : values ? [values] : []).filter(Boolean);
		if (!list.length) return;
		if (list.length === 1) lines.push(`- ${label}: ${list[0]}`);
		else {
			lines.push(`- ${label}:`);
			for (const item of list) lines.push(`  - ${item}`);
		}
	};
	stage("Product requirements", args.requirements);
	stage("Spec", args.spec);
	stage("Plans", args.plans);
	stage("Runs", args.runs);
	stage("Decisions", args.decisions);
	stage("Deployment", args.deployment);
	if (lines.length === 3) lines.push("- (no stages recorded yet)");
	if (Array.isArray(args.notes) && args.notes.length) {
		lines.push("", "## References");
		for (const note of args.notes) lines.push(`- ${note}`);
	}
	if (args.body) lines.push("", "## Detail", String(args.body));
	return `${lines.join("\n")}\n`;
}

export function buildProjectArgs(args = {}, root) {
	const basename = args.basename || `project-${slug(args.name ?? "project")}`;
	const out = ["note", "new", "project", basename];
	for (const repo of args.repos ?? []) out.push("--set", `repos=${repo}`);
	appendTrace(args, out);
	appendRoot(args, out, root);
	out.push("--body-stdin");
	return out;
}

function toolDef(name, description, parameters, execute) {
	return {
		name,
		description,
		parameters: { type: "object", properties: parameters, additionalProperties: false },
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [
				{
					type: "text",
					text: [value.stdout?.trim(), value.stderr?.trim(), value.code === 0 ? "" : `exit ${value.code ?? "timeout"}`].filter(Boolean).join("\n") || "(no output)",
				},
			],
		},
		async execute(args, exec) {
			return execute(args, exec);
		},
	};
}

export function registerVaultTools(ctx, { cli, root, runReport, isOrchestrator } = {}) {
	const guard = (exec) => {
		if (!isOrchestrator(exec.agent)) throw new Error("vault tools are orchestrator-only; subagents and workers have no vault access");
	};
	const defs = [
		toolDef(
			"vault_search",
			"Search the agent vault (read-only). Returns the top hits; a failed search is reported once and never blocks work.",
			{ query: S("Query words"), repo: S("Repo slug"), all: B("Search every repo"), status: S("active or any"), include_work: B("Include work/"), limit: { type: "number", description: "Max hits" }, json: B("Print JSON"), ...common(root) },
			async (args, exec) => {
				guard(exec);
				return cli.run(buildVaultArgs("vault_search", args, root));
			},
		),
		toolDef(
			"vault_note",
			"Create or update a vault note through vault.mjs. new/set/status/supersede; body goes to stdin. Never write a vault file directly.",
			{
				subcommand: { type: "string", enum: ["new", "set", "status", "supersede"], description: "Note operation" },
				type: S("Note type for new"),
				basename: S("Note basename"),
				sets: { type: "array", items: { type: "string" }, description: "k=v properties" },
				status: S("Status for note status"),
				old: S("Old note for supersede"),
				new: S("New note for supersede"),
				body: S("Body text, sent to stdin"),
				...common(root),
			},
			async (args, exec) => {
				guard(exec);
				return cli.run(buildVaultArgs("vault_note", args, root), { stdin: args.body });
			},
		),
		toolDef(
			"vault_work",
			"Run `work add` for a finished request, or `work pending` to list finished traces the vault misses.",
			{ action: { type: "string", enum: ["add", "pending"], description: "Work operation" }, trace: S("Trace id for add"), probes: B("Copy probes too"), root: S("Repo root") },
			async (args, exec) => {
				guard(exec);
				return cli.run(buildVaultArgs("vault_work", args, root));
			},
		),
		toolDef(
			"vault_log",
			"Append one line to the vault log.",
			{ text: S("Log line"), repo: S("Repo slug or -"), trace: S("Trace id"), root: S("Repo root") },
			async (args, exec) => {
				guard(exec);
				return cli.run(buildVaultArgs("vault_log", args, root));
			},
		),
		toolDef("vault_sync", "Pull or push the vault repository.", { action: { type: "string", enum: ["pull", "push"], description: "Sync operation" }, trace: S("Trace id"), root: S("Repo root") }, async (args, exec) => {
			guard(exec);
			return cli.run(buildVaultArgs("vault_sync", args, root));
		}),
		toolDef("vault_restore", "Rebuild specs and draft plans from the vault; never overwrites and never writes a ready plan.", { root: S("Repo root") }, async (args, exec) => {
			guard(exec);
			return cli.run(buildVaultArgs("vault_restore", args, root));
		}),
		toolDef("vault_config", "Push or pull .plans/config.json through the vault's config/dispatch.json.", { action: { type: "string", enum: ["push", "pull"], description: "Config operation" }, force: B("Replace the local file on pull"), root: S("Repo root") }, async (args, exec) => {
			guard(exec);
			return cli.run(buildVaultArgs("vault_config", args, root));
		}),
		toolDef(
			"vault_project",
			"Create or replace a project note that stores the pipeline from product requirements to deployment, with wikilinks or note basenames as stage values.",
			{
				name: S("Project name"),
				repos: { type: "array", items: { type: "string" }, description: "Repo slugs this project covers" },
				basename: S("Note basename; defaults to project-<slug(name)>"),
				requirements: S("Requirements note or link"),
				spec: S("Spec note or link"),
				plans: { type: "array", items: { type: "string" }, description: "Plan notes or links" },
				runs: { type: "array", items: { type: "string" }, description: "Run notes or links" },
				decisions: { type: "array", items: { type: "string" }, description: "Decision notes or links" },
				deployment: S("Deployment note or link"),
				notes: { type: "array", items: { type: "string" }, description: "Other references" },
				body: S("Extra detail appended to the note"),
				...common(root),
			},
			async (args, exec) => {
				guard(exec);
				if (!args.name) throw new Error("vault_project needs a project name");
				if (!Array.isArray(args.repos) || args.repos.length === 0) throw new Error("vault_project needs at least one repo");
				return cli.run(buildProjectArgs(args, root), { stdin: projectBody(args) });
			},
		),
		toolDef(
			"vault_record_run",
			"Record a finished run in the fixed order of the vault rules: report, run and finding notes, work add, plan/spec status, log append, and sync push when harness.json says auto.",
			{
				trace: S("Trace id (required)"),
				plan: S("Plan id"),
				spec: S("Spec id or file name"),
				repo: S("Repo slug or -"),
				gate: { type: "string", enum: ["pass", "fail"], description: "Gate result" },
				status: S("Override the note status"),
				summary: S("Run note body"),
				probes: B("Copy probes with work add"),
				finished: B("Set the spec status done (default true)"),
				findings: {
					type: "array",
					description: "Findings to record",
					items: {
						type: "object",
						properties: {
							fingerprint: S("fingerprint"),
							severity: S("blocker/major/minor/error/warn/info"),
							source: S("plan-audit/auditor/pair/security/gate"),
							title: S("Short title"),
							file: S("Repo-relative file or -"),
							text: S("Finding text"),
							body: S("Note body"),
						},
						additionalProperties: false,
					},
				},
				root: S("Repo root"),
				vault: S("Vault path, for harness.json"),
			},
			async (args, exec) => {
				guard(exec);
				const result = await recordRun({ cli, args: { ...args, root: args.root || root }, runReport });
				const failed = result.steps.filter((s) => s.code !== 0 && s.code !== 6);
				return {
					code: failed.length ? 1 : 0,
					stdout: result.steps.map((s) => `${s.label}: ${s.code === 0 ? "ok" : `exit ${s.code ?? "timeout"}`}`).join("\n") + (result.pushed ? "\nsync push: ok" : "\nsync push: not automatic"),
					stderr: "",
					timedOut: false,
				};
			},
		),
	];
	const disposers = defs.map((d) => ctx.tools.register(d));
	return () => {
		for (const dispose of disposers) dispose?.();
	};
}

export { slug };
