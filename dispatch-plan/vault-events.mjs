/**
 * Trace events for the agent-vault CLI. Plain Node, no dependencies.
 *
 * Events append to the same .plans/traces/<trace>.jsonl file the dispatcher writes.
 * A missing --root or --trace means no event, and a failed append never fails a command.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The first present field, so a write event spans note:<id> and a boot event spans kind:-. */
function spanPart(data) {
	if (data && data.id !== undefined) return data.id;
	if (data && data.op !== undefined) return data.op;
	if (data && data.reason !== undefined) return data.reason;
	return "-";
}

export function emitEvent({ root, trace }, kind, data) {
	if (!root || !trace) return;
	try {
		const event = {
			v: 1,
			ts: new Date().toISOString(),
			trace,
			span: `${kind}:${spanPart(data)}`,
			actor: "vault",
			kind,
			data,
		};
		const file = path.join(root, ".plans", "traces", `${trace}.jsonl`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
	} catch {
		// Tracing must never break a vault command.
	}
}

/** The event payload for a bootText string: its size, its item count and how many items were dropped. */
export function bootEventData(text) {
	const value = typeof text === "string" ? text : "";
	const lines = value.split("\n");
	const items = lines.filter((line) => line.startsWith("=== ") && line.endsWith(" ===")).length;
	let last = "";
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() !== "") {
			last = lines[i].trim();
			break;
		}
	}
	const match = /^\[truncated: (\d+) items\]$/.exec(last);
	return {
		bytes: Buffer.byteLength(value),
		items,
		truncated: match ? Number(match[1]) : 0,
	};
}
