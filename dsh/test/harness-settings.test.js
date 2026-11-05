import { test } from "node:test";
import assert from "node:assert/strict";
import { apply as hostApply, name as hostName } from "../plugins/harness-settings/index.js";

const loaded = [];
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			loaded.push(definition);
		},
	},
};

await import("../plugins/harness-settings/client.js");

function fakeReact() {
	return {
		createElement(type, props, ...children) {
			return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) };
		},
	};
}

function textOf(node) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join(" ");
	if (typeof node.type === "function") {
		const children = node.children.length === 0 ? undefined : node.children.length === 1 ? node.children[0] : node.children;
		return textOf(node.type({ ...node.props, children }));
	}
	return textOf(node.children);
}

function loadClient() {
	const definition = loaded[0];
	assert.ok(definition, "the client module registered a loader definition");
	assert.equal(definition.id, "@pi-harness/dsh-plugin-harness-settings");
	return definition.factory((id) => {
		assert.equal(id, "react");
		return fakeReact();
	});
}

function mountSection(client) {
	let dictionaries;
	let injectedSlot;
	let registration;
	const ctx = {
		effect(callback) {
			return callback();
		},
		locale: {
			register(namespace, locale, value) {
				dictionaries = { namespace, locale, value };
				return () => {};
			},
			bind() {
				return (key) => dictionaries?.value[key] ?? key;
			},
		},
		slots: {
			inject(slot, register) {
				injectedSlot = slot;
				return register();
			},
			register(options, Component) {
				registration = { options, Component };
				return () => {};
			},
		},
	};
	client.apply(ctx);
	return { dictionaries, injectedSlot, registration };
}

test("the client registers one Harness settings section", () => {
	const client = loadClient();
	assert.deepEqual(client.inject, ["slots", "locale"]);

	const { dictionaries, injectedSlot, registration } = mountSection(client);
	assert.equal(injectedSlot, "settings.section");
	assert.equal(dictionaries.namespace, "harness-settings");
	assert.equal(dictionaries.locale, "en");
	assert.equal(dictionaries.value.title, "Harness");

	assert.equal(registration.options.name, "settings.section");
	assert.equal(registration.options.id, "harness");
	assert.equal(registration.options.order, 15);
	assert.equal(registration.options.locale, "harness-settings");
	assert.equal(registration.options.label(), "Harness");
	assert.equal(typeof registration.options.inject, "function");
});

test("the section renders the four plugin rows without a DOM", () => {
	const client = loadClient();
	const { registration } = mountSection(client);
	const face = registration.options.inject();
	const tree = registration.Component({ close() {}, ...face });
	const rendered = textOf(tree);

	for (const expected of [
		"Harness Dispatch",
		".plans/inbox",
		".plans/config.json",
		"Harness Vault",
		"skillRoot",
		"Harness Monitor",
		"/api/state",
		"Harness Usage",
		"/plugins/harness-usage/state",
	]) {
		assert.ok(rendered.includes(expected), `rendered section contains ${expected}`);
	}
	assert.equal((rendered.match(/Status:/g) ?? []).length, 5);
});

test("the host row is an empty apply", async () => {
	assert.equal(hostName, "harness-settings");
	assert.equal(await hostApply(), undefined);
});
