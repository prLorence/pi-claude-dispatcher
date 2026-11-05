import { test } from "node:test";
import assert from "node:assert/strict";
import { splitModel } from "../plugins/harness-dispatch/worker.js";

test("splitModel splits provider from model at the first slash", () => {
	assert.deepEqual(splitModel("opencode-go/deepseek-v4.1-flash"), { provider: "opencode-go", model: "deepseek-v4.1-flash" });
	assert.deepEqual(splitModel("fake-model"), { provider: undefined, model: "fake-model" });
	assert.deepEqual(splitModel("a/b/c"), { provider: "a", model: "b/c" });
});
