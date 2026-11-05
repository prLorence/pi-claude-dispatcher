/** Vault note basenames are lowercase words joined by single dashes. */
export function slug(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "note";
}
