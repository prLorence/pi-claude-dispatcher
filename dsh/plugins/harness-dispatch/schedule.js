/** File-overlap scheduling and dependency ordering, ported from core.ts. */

function norm(p) {
	return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Two file lists overlap if they share a path, or one is a directory prefix of the other. */
export function filesOverlap(a, b) {
	for (const x of a.map(norm))
		for (const y of b.map(norm)) {
			if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
		}
	return false;
}

/**
 * Pick tasks that can start now: all dependencies done, no file overlap with
 * running or newly picked tasks, and a task with no files runs alone.
 */
export function pickRunnable(plan, limit) {
	const byId = new Map(plan.tasks.map((t) => [t.id, t]));
	for (const t of plan.tasks) {
		if (t.state !== "pending") continue;
		if (t.dependsOn.some((d) => ["failed", "skipped"].includes(byId.get(d).state))) {
			t.state = "skipped";
			t.summary = "Skipped: a dependency failed.";
		}
	}

	const running = plan.tasks.filter((t) => t.state === "running");
	if (running.some((t) => t.files.length === 0)) return [];
	const slots = limit - running.length;
	if (slots <= 0) return [];

	const picked = [];
	for (const t of plan.tasks) {
		if (picked.length >= slots) break;
		if (t.state !== "pending") continue;
		if (!t.dependsOn.every((d) => byId.get(d).state === "done")) continue;
		const busy = [...running, ...picked];
		if (t.files.length === 0) {
			if (busy.length === 0) {
				picked.push(t);
				break;
			}
			continue;
		}
		if (busy.some((b) => filesOverlap(b.files, t.files))) continue;
		picked.push(t);
	}
	return picked;
}

export function isPlanFinished(plan) {
	return plan.tasks.every((t) => ["done", "failed", "skipped"].includes(t.state));
}
