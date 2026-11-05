/** Result files: per-task reports and _summary.md, byte-compatible with core.ts. */
import * as fs from "node:fs";
import * as path from "node:path";

export function writeTaskResult(outDir, task, r) {
	fs.mkdirSync(outDir, { recursive: true });
	const secs = task.startedAt && task.endedAt ? Math.round((task.endedAt - task.startedAt) / 1000) : 0;
	const body = [
		`# ${task.id}: ${task.state}`,
		"",
		`- attempts: ${task.attempts}`,
		`- duration: ${secs}s`,
		`- cost: $${(task.cost || 0).toFixed(4)}`,
		task.files.length ? `- files: ${task.files.join(", ")}` : "- files: (none listed)",
		r.session ? `- session: \`${r.session.id}\`${r.session.file ? ` (${r.session.file})` : ""}` : "",
		r.error ? `- error: ${r.error}` : "",
		"",
		"## Worker report",
		"",
		r.output || "(no output)",
		"",
	]
		.filter((l) => l !== "")
		.join("\n");
	fs.writeFileSync(path.join(outDir, `${task.id}.md`), `${body}\n`);
}

export function writeSummary(outDir, plan, extra = []) {
	const total = plan.tasks.reduce((s, t) => s + (t.cost || 0), 0);
	const counts = (s) => plan.tasks.filter((t) => t.state === s).length;
	const lines = [
		`# Plan ${plan.id}: results`,
		"",
		`done ${counts("done")} · failed ${counts("failed")} · skipped ${counts("skipped")} · cost $${total.toFixed(4)}`,
		"",
		...extra,
		"| task | state | attempts | report |",
		"|---|---|---|---|",
		...plan.tasks.map((t) => `| ${t.id} | ${t.state} | ${t.attempts} | [${t.id}.md](./${t.id}.md) |`),
		"",
		"## Short reports",
		"",
		...plan.tasks.map((t) => `### ${t.id} (${t.state})\n\n${(t.summary || "").slice(0, 1500)}\n`),
	];
	fs.writeFileSync(path.join(outDir, "_summary.md"), `${lines.join("\n")}\n`);
}

export function writeVerifyReport(outDir, file, command, r, timeoutMinutes) {
	const outcome = r.timedOut ? `timed out after ${timeoutMinutes} min` : `exit code: ${r.code ?? "none"}`;
	const body = [
		`# verification: ${r.ok ? "PASS" : "FAIL"}`,
		"",
		`- command: \`${command}\``,
		`- ${outcome}`,
		`- duration: ${(r.durationMs / 1000).toFixed(1)}s`,
		"",
		"## Output (tail)",
		"",
		r.output.trim() || "(no output)",
	];
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, file), `${body.join("\n")}\n`);
}
