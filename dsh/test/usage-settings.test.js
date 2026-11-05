import { test } from "node:test";
import assert from "node:assert/strict";

const loaded = [];
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			loaded.push(definition);
		},
	},
};

await import("../plugins/harness-usage/client.js");

function loadClient() {
	const definition = loaded[0];
	assert.ok(definition, "the usage client registered a loader definition");
	assert.equal(definition.id, "@pi-harness/dsh-plugin-harness-usage");
	return definition.factory(() => ({ createElement() {} }));
}

test("the usage client registers both the sidebar widget and a Usage settings section", () => {
	const client = loadClient();
	assert.deepEqual(client.inject, ["slots"]);
	const registrations = [];
	const ctx = {
		slots: {
			inject(slot, register) {
				registrations.push({ slot, value: register() });
				return () => {};
			},
			register(options, Component) {
				return { options, Component };
			},
		},
	};
	client.apply(ctx);
	const sidebar = registrations.find((r) => r.slot === "sidebar.footer.action");
	const settings = registrations.find((r) => r.slot === "settings.section");
	assert.equal(sidebar.value.options.id, "harness-usage");
	assert.equal(settings.value.options.name, "settings.section");
	assert.equal(settings.value.options.id, "harness-usage");
	assert.equal(settings.value.options.order, 16);
	assert.equal(settings.value.options.label(), "Usage");
	assert.equal(typeof settings.value.Component, "function");
});
