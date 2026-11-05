import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { apply } from "../plugins/harness-vault/index.js";
import { makeSkillRoot } from "../fixtures/vault-env.js";

function fakeCtx(root) {
	const rootAgent = { id: "root" };
	const tools = new Map();
	const guards = [];
	const sections = [];
	const disposers = [];
	const ctx = {
		tools: {
			register(def) {
				tools.set(def.name, def);
				const dispose = () => tools.delete(def.name);
				disposers.push(dispose);
				return dispose;
			},
			guard(fn) {
				guards.push(fn);
				return () => {};
			},
			get(name) {
				return tools.get(name);
			},
		},
		systemPrompt: {
			section(section) {
				sections.push(section);
				return () => {};
			},
		},
		agents: { roots: () => [rootAgent] },
		workingDirectory: { defaultDirectory: root },
		logger: { info: () => {} },
	};
	return { ctx, rootAgent, tools, guards, sections, disposers };
}

test("the vault plugin registers the orchestrator tools and a boot section", async () => {
	const skill = makeSkillRoot();
	const h = fakeCtx(process.cwd());
	try {
		const dispose = await apply(h.ctx, { skillRoot: skill.root, injectVaultBoot: false });
		assert.deepEqual(
			[...h.tools.keys()].sort(),
			["vault_config", "vault_log", "vault_note", "vault_project", "vault_record_run", "vault_restore", "vault_search", "vault_sync", "vault_work"],
		);
		assert.equal(h.sections[0].name, "harness-vault");
		assert.equal(h.sections[0].text(), "");
		assert.equal(h.guards.length, 1);
		assert.equal(h.guards[0]({ name: "vault_search", agent: h.rootAgent }), undefined);
		assert.match(h.guards[0]({ name: "vault_search", agent: { id: "child" } }), /orchestrator-only/);
		dispose();
		assert.equal(h.tools.size, 0);
	} finally {
		fs.rmSync(skill.root, { recursive: true, force: true });
	}
});
