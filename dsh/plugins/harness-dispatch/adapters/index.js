/** Adapter registry: `dsh` (default), `pi` and `omp`. */
import { dshAdapter } from "./dsh.js";
import { piAdapter } from "./pi.js";
import { ompAdapter } from "./omp.js";

const ADAPTERS = new Map([
	[dshAdapter.name, dshAdapter],
	[piAdapter.name, piAdapter],
	[ompAdapter.name, ompAdapter],
]);

export function getAdapter(name) {
	return ADAPTERS.get(name);
}

export function knownAgents() {
	return [...ADAPTERS.keys()];
}
