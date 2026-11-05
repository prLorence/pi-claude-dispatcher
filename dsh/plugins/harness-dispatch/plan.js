/**
 * Plan parsing, byte-compatible with pi-plan-dispatch/core.ts.
 * No imports, so it loads on its own.
 */

export function safeId(v) {
	return String(v).replace(/[^\w.-]+/g, "-");
}

export class PlanParseError extends Error {}

function parseList(v) {
	const s = v.trim().replace(/^\[/, "").replace(/\]$/, "");
	return s
		.split(",")
		.map((x) => x.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

function stripComment(v) {
	return v.replace(/\s+#.*$/, "").trim();
}

export function parsePlan(text, fallbackId) {
	const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!fm) throw new PlanParseError("Missing frontmatter (--- ... ---) at top of plan");
	const meta = {};
	let planVerify;
	for (const line of fm[1].split(/\r?\n/)) {
		const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
		if (!m) continue;
		const key = m[1].toLowerCase();
		// A verify command is a shell line: `#` is not a comment there.
		if (key === "verify") planVerify = m[2].trim() || undefined;
		else meta[key] = stripComment(m[2]);
	}
	const rest = text.slice(fm[0].length);

	const parts = rest.split(/^##\s+task:\s*/im);
	const context = parts[0].trim();
	const tasks = [];
	const seen = new Set();

	for (const chunk of parts.slice(1)) {
		const lines = chunk.split(/\r?\n/);
		const id = lines[0].trim().split(/\s+/)[0];
		if (!id) throw new PlanParseError("A '## task:' heading has no id");
		if (seen.has(id)) throw new PlanParseError(`Duplicate task id: ${id}`);
		seen.add(id);

		const task = { id, files: [], dependsOn: [], body: "", state: "pending", attempts: 0, pairRound: 0 };
		let i = 1;
		for (; i < lines.length; i++) {
			const m = /^(files|depends_on|model|thinking|verify|role|pair|pair_rounds)\s*:\s*(.*)$/i.exec(lines[i].trim());
			if (!m) {
				if (lines[i].trim() === "") continue;
				break;
			}
			const key = m[1].toLowerCase();
			if (key === "verify") {
				task.verify = m[2].trim() || undefined;
				continue;
			}
			const val = stripComment(m[2]);
			if (key === "files") task.files = parseList(val);
			else if (key === "depends_on") task.dependsOn = parseList(val);
			else if (key === "model") task.model = val;
			else if (key === "thinking") task.thinking = val;
			else if (key === "role") task.role = val || undefined;
			else if (key === "pair") {
				if (!val) {
					// An empty value counts as no pair line.
				} else if (val.toLowerCase() === "none") task.pairSource = "none";
				else {
					task.pair = val;
					task.pairSource = "task";
				}
			} else if (key === "pair_rounds") task.pairRounds = val === "" ? Number.NaN : Number.parseInt(val, 10);
		}
		if (task.pair && task.pairRounds === undefined) task.pairRounds = 2;
		task.body = lines.slice(i).join("\n").trim();
		if (!task.body) throw new PlanParseError(`Task ${id} has no instructions`);
		tasks.push(task);
	}

	if (tasks.length === 0) throw new PlanParseError("Plan has no '## task: <id>' sections");
	for (const t of tasks)
		for (const dep of t.dependsOn) if (!seen.has(dep)) throw new PlanParseError(`Task ${t.id} depends on unknown task ${dep}`);
	detectCycle(tasks);

	const id = safeId(meta["id"] || fallbackId);
	const mp = meta["max_parallel"] ? Number.parseInt(meta["max_parallel"], 10) : undefined;
	return {
		id,
		trace: meta["trace"] ? safeId(meta["trace"]) : id,
		parent: meta["parent"] ? safeId(meta["parent"]) : undefined,
		round: meta["round"] && Number.parseInt(meta["round"], 10) > 0 ? Number.parseInt(meta["round"], 10) : undefined,
		status: (meta["status"] || "").toLowerCase(),
		maxParallel: mp && mp > 0 ? mp : undefined,
		model: meta["model"] || undefined,
		thinking: meta["thinking"] || undefined,
		verify: planVerify,
		context,
		tasks,
	};
}

function detectCycle(tasks) {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const mark = new Map();
	const visit = (id, trail) => {
		if (mark.get(id) === 2) return;
		if (mark.get(id) === 1) throw new PlanParseError(`Dependency cycle: ${[...trail, id].join(" -> ")}`);
		mark.set(id, 1);
		for (const d of byId.get(id).dependsOn) visit(d, [...trail, id]);
		mark.set(id, 2);
	};
	for (const t of tasks) visit(t.id, []);
}

/** Read just the status field without fully parsing (cheap check for pickup). */
export function readStatus(text) {
	const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!fm) return "";
	const m = /^status\s*:\s*(.*)$/im.exec(fm[1]);
	return m ? stripComment(m[1]).toLowerCase() : "";
}
