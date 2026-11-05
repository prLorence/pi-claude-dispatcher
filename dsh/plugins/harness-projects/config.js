/**
 * Config defaults and normalization. Every value is also a `Config` key in the
 * bundle patch, so a user changes behavior in cordis.patch.yml and the override
 * survives an upgrade.
 */
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULTS = {
	enabled: true,
	warm: true,
	roots: [],
	registryPath: "",
	skillRoot: "",
	budget: 1200,
	refreshSeconds: 20,
	discoverWorkspaces: true,
	maxRepos: 80,
	warmForSubagents: true,
};

function expand(value, home) {
	const text = String(value ?? "").trim();
	if (!text) return "";
	if (text === "~") return home;
	return text.startsWith("~/") ? path.join(home, text.slice(2)) : text;
}

export function normalizeConfig(config = {}, { home = os.homedir() } = {}) {
	const merged = { ...DEFAULTS, ...(config ?? {}) };
	const budget = Number(merged.budget);
	const refresh = Number(merged.refreshSeconds);
	const maxRepos = Number(merged.maxRepos);
	return {
		...merged,
		warm: merged.warm !== false,
		enabled: merged.enabled !== false,
		discoverWorkspaces: merged.discoverWorkspaces !== false,
		warmForSubagents: merged.warmForSubagents !== false,
		roots: (Array.isArray(merged.roots) ? merged.roots : [merged.roots]).map((root) => expand(root, home)).filter(Boolean),
		registryPath: expand(merged.registryPath, home),
		skillRoot: expand(merged.skillRoot, home),
		budget: Number.isFinite(budget) && budget > 0 ? Math.min(8000, Math.round(budget)) : DEFAULTS.budget,
		refreshSeconds: Number.isFinite(refresh) && refresh > 0 ? Math.min(3600, Math.round(refresh)) : DEFAULTS.refreshSeconds,
		maxRepos: Number.isFinite(maxRepos) && maxRepos > 0 ? Math.min(1000, Math.round(maxRepos)) : DEFAULTS.maxRepos,
	};
}
