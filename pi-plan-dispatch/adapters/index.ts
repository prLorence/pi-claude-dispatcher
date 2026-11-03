/**
 * The adapter registry: the agent names a role may ask for.
 *
 * Today only Pi is registered. A name is matched exactly, and a key that only
 * exists on `Object.prototype` (say, "toString") is not an agent.
 */
import { piAdapter } from "./pi.ts";
import type { AgentAdapter } from "./types.ts";

const REGISTRY: Record<string, AgentAdapter> = {
	pi: piAdapter,
};

/** The adapter registered under `name`, or undefined when the name is unknown. */
export function getAdapter(name: string): AgentAdapter | undefined {
	return Object.hasOwn(REGISTRY, name) ? REGISTRY[name] : undefined;
}

/** Every agent name a role may name today. */
export function knownAgents(): string[] {
	return Object.keys(REGISTRY);
}
