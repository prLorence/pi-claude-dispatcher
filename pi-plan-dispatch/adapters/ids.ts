/**
 * Identifier sanitising shared by the core and the adapters.
 *
 * Kept in its own module so the adapter modules never import `core.ts`; the
 * core re-exports it, so `safeId` stays part of the core's public surface.
 */

/** Replace every run of characters that are unsafe in a file or session name with a dash. */
export function safeId(v: string): string {
	return v.replace(/[^\w.-]+/g, "-");
}
