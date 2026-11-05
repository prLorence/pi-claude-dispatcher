/**
 * The fixed record order of CLAUDE.md vault rule 2, because the wrong order
 * loses data:
 *   1. trace.mjs report
 *   2. the run note and every finding note (`note new`)
 *   3. `work add`
 *   4. plan status, and spec status when finished
 *   5. `log append`
 *   6. `sync push` when harness.json says auto
 *
 * This module only builds arguments and calls the CLI; vault.mjs is the writer.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { slug } from "./naming.js";

export function findingBasename(trace, fingerprint) {
	return `${slug(trace)}-f-${createHash("sha1").update(fingerprint).digest("hex").slice(0, 8)}`;
}

export function readSyncPush(vault) {
	if (!vault) return "manual";
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(vault, "harness.json"), "utf8"));
		return raw?.sync_push === "auto" ? "auto" : "manual";
	} catch {
		return "manual";
	}
}

function statusOf(plan, gate) {
	if (plan?.status === "failed") return "failed";
	if (gate === "fail") return "failed";
	return "done";
}

/**
 * `args`:
 *   trace (required), root, repo, plan (plan id), spec (spec id or basename),
 *   gate ("pass"|"fail"), status, findings[], probes, finished, summary,
 *   runReport?: async () => void | {ok,line}
 */
export async function recordRun({ cli, args = {}, runReport, log } = {}) {
	const trace = args.trace;
	if (!trace) throw new Error("vault_record_run needs a trace");
	const root = args.root;
	const repo = args.repo || "-";
	const status = statusOf(args, args.gate);
	const planId = args.plan;
	const planNote = planId ? slug(planId) : undefined;
	const specNote = args.spec ? `${slug(path.basename(args.spec, ".md"))}-spec` : undefined;
	const steps = [];

	const step = async (label, argv, opts = {}) => {
		const result = await cli.run(argv, opts);
		steps.push({ label, argv, code: result.code, timedOut: result.timedOut });
		return result;
	};

	// 1. The report must exist before work add copies it.
	if (runReport) {
		const reported = await runReport(trace);
		steps.push({ label: "report", code: reported?.code ?? 0 });
		if (reported && reported.code !== 0) log?.(`vault run record: trace report failed (exit ${reported.code}); carrying on`);
	}

	// 2. Run and finding notes, before work add sets `unmirrored`.
	const runBody = args.summary || `Run ${planId ?? trace}: gate ${args.gate ?? "unknown"}.`;
	const runSet = [`trace=${trace}`, `repo=${repo}`, `status=${status}`, `gate=${args.gate === "pass" ? "pass" : "fail"}`];
	if (planId) runSet.push(`plan=${planId}`);
	await step("note new run", ["note", "new", "run", `${slug(planId ?? trace)}-run`, ...runSet.flatMap((s) => ["--set", s]), "--body-stdin"], { stdin: `${runBody}\n` });

	for (const finding of args.findings ?? []) {
		const fingerprint = String(finding.fingerprint ?? `${repo}:${finding.file ?? "-"}:${slug(finding.title ?? finding.text ?? "finding")}`);
		const basename = findingBasename(trace, fingerprint);
		const set = [
			`trace=${trace}`,
			`repo=${repo}`,
			`severity=${finding.severity ?? "warn"}`,
			`fingerprint=${fingerprint}`,
			`source=${finding.source ?? "gate"}`,
			"status=open",
		];
		const body = finding.body ?? finding.text ?? finding.title ?? fingerprint;
		await step("note new finding", ["note", "new", "finding", basename, ...set.flatMap((s) => ["--set", s]), "--body-stdin"], { stdin: `${body}\n` });
	}

	// 3. The run record.
	const workArgs = ["work", "add", "--trace", trace];
	if (root) workArgs.push("--root", root);
	if (args.probes) workArgs.push("--probes");
	await step("work add", workArgs);

	// 4. Plan status, then the spec status when the request is finished.
	if (planNote) await step("note set plan", ["note", "set", planNote, "--set", `status=${status}`]);
	if (specNote && args.finished !== false) await step("note set spec", ["note", "set", specNote, "--set", "status=done"]);

	// 5. The log line.
	const logArgs = ["log", "append", "--repo", repo, "--trace", trace, `plan ${planId ?? trace} ${status}: gate ${args.gate ?? "unknown"}`];
	await step("log append", logArgs);

	// 6. Push only when the vault says auto.
	let pushed = false;
	if (readSyncPush(args.vault) === "auto") {
		await step("sync push", ["sync", "push"]);
		pushed = true;
	}

	return { steps, pushed, status };
}
