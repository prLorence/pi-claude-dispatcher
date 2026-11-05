import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProjectArgs, projectBody } from "../plugins/harness-vault/tools.js";

test("projectBody renders the product-to-deployment pipeline", () => {
	const body = projectBody({
		name: "Checkout",
		requirements: "[[spec-checkout]]",
		spec: "[[spec-checkout]]",
		plans: ["[[p-r1]]", "[[p-r2]]"],
		runs: "[[p-r1-run]]",
		decisions: "[[decision-checkout-db]]",
		deployment: "[[deploy-checkout]]",
		notes: ["[[codebase-org-checkout]]"],
	});
	assert.match(body, /^# Checkout/m);
	assert.match(body, /## Pipeline/);
	assert.match(body, /- Product requirements: \[\[spec-checkout\]\]/);
	assert.match(body, /- Plans:/);
	assert.match(body, /  - \[\[p-r1\]\]/);
	assert.match(body, /- Deployment: \[\[deploy-checkout\]\]/);
	assert.match(body, /## References/);
});

test("projectBody omits empty stages and keeps extra detail", () => {
	const body = projectBody({ name: "X", requirements: "reqs", body: "long detail" });
	assert.match(body, /- Product requirements: reqs/);
	assert.doesNotMatch(body, /Deployment:/);
	assert.match(body, /## Detail\nlong detail/);
});

test("buildProjectArgs repeats repos and sends the body on stdin", () => {
	const args = buildProjectArgs({ name: "Checkout App", repos: ["org/checkout", "org/checkout-infra"], trace: "T", root: "/repo" }, "/repo");
	assert.deepEqual(args, [
		"note",
		"new",
		"project",
		"project-checkout-app",
		"--set",
		"repos=org/checkout",
		"--set",
		"repos=org/checkout-infra",
		"--trace",
		"T",
		"--root",
		"/repo",
		"--body-stdin",
	]);
});
