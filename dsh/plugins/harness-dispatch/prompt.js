/** Worker prompts, ported from core.ts. */
import { resolveRole } from "./roles.js";

export function buildWorkerPrompt(plan, task, cfg) {
	const owned = task.files.length
		? `You own ONLY these paths: ${task.files.join(", ")}.\nDo not edit any other file. Other workers are editing other files at the same time. If you truly need a change elsewhere, don't make it: describe it under NEEDS.`
		: "No file list was given for this task; keep changes minimal and focused.";
	const retry = task.feedback ? retrySection(task.feedback, task.feedbackKind) : "";
	const rolePrompt = resolveRole(cfg, task.role || "implement").prompt;
	const role = rolePrompt ? `## Your role\n${rolePrompt}` : "";
	const grounding = [
		"## Grounding rules",
		"- Read every file before you edit it. Never edit from memory.",
		"- Never invent function names, APIs, file paths or package names. Verify them by reading the code or searching for them.",
		"- If something you need is missing or unclear, stop and put it under NEEDS instead of guessing.",
		"- Only report test results from commands you actually ran, and quote the real output line.",
		"- Do not claim a change you did not make.",
	].join("\n");
	return [
		`You are a worker executing one task from plan "${plan.id}".`,
		plan.context ? `## Plan context\n${plan.context}` : "",
		`## Your task: ${task.id}\n${task.body}`,
		retry,
		role,
		`## Rules\n${owned}\nDo not commit to git. Run the relevant tests or checks before finishing if the task names them.`,
		grounding,
		`## Final message format\nEnd with exactly these sections:\nSTATUS: done | failed\nCHANGED: <files you changed, one per line>\nTESTS: <commands run and result>\nNOTES: <anything the reviewer should know>\nNEEDS: <changes needed outside your files, or "none">`,
	]
		.filter(Boolean)
		.join("\n\n");
}

function retrySection(feedback, kind) {
	if (kind === "review") {
		return `## A reviewer found problems with your change\n${feedback}\nFix the cause of each finding, or explain under NOTES why a finding is wrong. Do not re-run the same thing blindly.`;
	}
	return `## Your previous attempt failed verification\n${feedback}\nFix the cause of the failure. Do not re-run the same thing blindly.`;
}
