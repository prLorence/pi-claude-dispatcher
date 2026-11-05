/**
 * Host half of the Harness settings section.
 *
 * The section is entirely a Client surface: it reads no Host service and owns
 * no configuration of its own. This empty row exists so the bundle has a Host
 * entry and the Client half is loaded with it.
 */
export const name = "harness-settings";

export function apply() {}

export default { name, apply };
