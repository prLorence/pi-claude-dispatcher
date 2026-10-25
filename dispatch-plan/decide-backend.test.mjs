/** Run with: node --test dispatch-plan/decide-backend.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	BackendError,
	fakeBackend,
	loadKey,
	openRouterBackend,
	redact,
} from "./decide-backend.mjs";

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "perplexity/pplx-decider-flash-v1.2";
const KEY = `sk-or-v1-${"0".repeat(64)}`;

const request = {
	state: { task: "Do the thing", files: ["a.ts"], role: "implement" },
	questions: {
		effort: {
			type: "choice",
			instructions: "How much reasoning effort?",
			criteria: { low: "easy", high: "hard", max: "intricate" },
		},
	},
};

const answer = {
	model: `${MODEL}-20261016`,
	answers: {
		effort: {
			type: "choice",
			choice: "high",
			probabilities: { low: 0.1, high: 0.8, max: 0.1 },
			confidence: 0.9,
		},
	},
	usage: { input_tokens: 120, output_tokens: 4, cost: 0.000004 },
};

/** A fetch reply: `json()` parses the body, so a plain string can stand for a broken body. */
function reply(status, body) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => JSON.parse(text),
		text: async () => text,
	};
}

/** A fake `fetchImpl` that hands out the replies in order and records every call. */
function scripted(replies) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		const next = replies.shift();
		assert.ok(next, "the test scripted a reply for every call");
		if (typeof next === "function") return next(url, init);
		if (next instanceof Error) throw next;
		return next;
	};
	return { calls, fetchImpl };
}

function backendFor(fetchImpl, extra = {}) {
	return openRouterBackend({
		key: KEY,
		model: MODEL,
		timeoutMs: 1000,
		fetchImpl,
		sleep: async () => {},
		...extra,
	});
}

function isBackendError(kind, status) {
	return (error) => {
		assert.equal(error instanceof BackendError, true, "the error is a BackendError");
		assert.equal(error.kind, kind);
		assert.equal(error.status, status);
		return true;
	};
}

function homeWithKey(text) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-decide-backend-"));
	const file = path.join(home, ".config", "pi-plan-dispatch", "openrouter.key");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (text !== undefined) fs.writeFileSync(file, text);
	return home;
}

test("a 200 answer comes back with its answers, usage and model", async () => {
	const { calls, fetchImpl } = scripted([reply(200, answer)]);
	const backend = backendFor(fetchImpl);

	const result = await backend.ask(request);

	assert.equal(backend.name, "openrouter");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, ENDPOINT);
	assert.equal(calls[0].init.method, "POST");
	assert.deepEqual(calls[0].init.headers, {
		Authorization: `Bearer ${KEY}`,
		"Content-Type": "application/json",
	});
	assert.deepEqual(JSON.parse(calls[0].init.body), {
		model: MODEL,
		state: request.state,
		questions: request.questions,
	});
	assert.ok(calls[0].init.signal instanceof AbortSignal, "the request carries a timeout signal");
	assert.deepEqual(result, {
		answers: answer.answers,
		usage: { input_tokens: 120, output_tokens: 4, cost: 0.000004 },
		model: `${MODEL}-20261016`,
	});
});

test("a missing usage is reported as zeros", async () => {
	const { fetchImpl } = scripted([reply(200, { model: MODEL, answers: answer.answers })]);
	const backend = backendFor(fetchImpl);

	const result = await backend.ask(request);

	assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0, cost: 0 });
	assert.equal(result.model, MODEL);
});

test("a 401 fails at once with the status and the server message", async () => {
	const sleeps = [];
	const { calls, fetchImpl } = scripted([
		reply(401, { error: { message: "User not found" } }),
	]);
	const backend = backendFor(fetchImpl, {
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});

	await assert.rejects(backend.ask(request), (error) => {
		assert.equal(isBackendError("http", 401)(error), true);
		assert.match(error.message, /401/u);
		assert.match(error.message, /User not found/u);
		return true;
	});
	assert.equal(calls.length, 1, "a 401 is not retried");
	assert.deepEqual(sleeps, []);
});

test("a 429 is retried once after two seconds and then succeeds", async () => {
	const sleeps = [];
	const { calls, fetchImpl } = scripted([
		reply(429, { error: { message: "rate limited" } }),
		reply(200, answer),
	]);
	const backend = backendFor(fetchImpl, {
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});

	const result = await backend.ask(request);

	assert.equal(calls.length, 2);
	assert.deepEqual(sleeps, [2000]);
	assert.deepEqual(result.answers, answer.answers);
});

test("a 500 twice gives one retry and then the error", async () => {
	const sleeps = [];
	const { calls, fetchImpl } = scripted([
		reply(500, { error: { message: "server broke" } }),
		reply(503, { error: { message: "still broken" } }),
	]);
	const backend = backendFor(fetchImpl, {
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});

	await assert.rejects(backend.ask(request), (error) => {
		assert.equal(isBackendError("http", 503)(error), true);
		assert.match(error.message, /still broken/u);
		return true;
	});
	assert.equal(calls.length, 2, "exactly one retry");
	assert.deepEqual(sleeps, [2000]);
});

test("a request that runs past the timeout fails as a timeout", async () => {
	// Waits for the abort signal, the way a stalled socket does.
	const fetchImpl = (url, init) =>
		new Promise((resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(init.signal.reason), {
				once: true,
			});
		});
	const backend = backendFor(fetchImpl, { timeoutMs: 10 });

	await assert.rejects(backend.ask(request), (error) => {
		assert.equal(isBackendError("timeout", 0)(error), true);
		assert.match(error.message, /timed out/u);
		return true;
	});
});

test("a network failure is an http error with status 0", async () => {
	const { calls, fetchImpl } = scripted([new TypeError("fetch failed")]);
	const backend = backendFor(fetchImpl);

	await assert.rejects(backend.ask(request), (error) => {
		assert.equal(isBackendError("http", 0)(error), true);
		assert.match(error.message, /fetch failed/u);
		return true;
	});
	assert.equal(calls.length, 1, "a network failure is not retried");
});

test("a body that is not JSON, or has no answers, is malformed", async () => {
	const broken = backendFor(scripted([reply(200, "not json at all")]).fetchImpl);
	await assert.rejects(broken.ask(request), isBackendError("malformed", 200));

	const empty = backendFor(scripted([reply(200, { model: MODEL })]).fetchImpl);
	await assert.rejects(empty.ask(request), isBackendError("malformed", 200));
});

test("the key never appears in an error message, even when the server echoes it", async () => {
	const echoed = {
		error: { message: `Incorrect API key provided: ${KEY}. Check your key.` },
	};
	const { fetchImpl } = scripted([reply(401, echoed)]);
	const backend = backendFor(fetchImpl);

	await assert.rejects(backend.ask(request), (error) => {
		assert.equal(error.message.includes(KEY), false, "the key is absent");
		assert.equal(error.message.includes("sk-or-"), false, "no sk-or- token survives");
		assert.equal(error.message.includes(request.state.task), false, "no request text");
		assert.match(error.message, /<redacted>/u);
		return true;
	});
});

test("a long server message is cut to 200 characters", async () => {
	const long = "x".repeat(500);
	const { fetchImpl } = scripted([reply(400, { error: { message: long } })]);
	const backend = backendFor(fetchImpl);

	await assert.rejects(backend.ask(request), (error) => {
		assert.ok(error.message.includes("x".repeat(200)), "the first 200 characters stay");
		assert.equal(error.message.includes("x".repeat(201)), false, "nothing past 200 stays");
		return true;
	});
});

test("redact replaces every sk-or- token and the exact key", () => {
	assert.equal(
		redact(`rejected sk-or-v1-abc123 and sk-or-v1-def456`),
		"rejected <redacted> and <redacted>",
	);
	assert.equal(redact("token my-secret-key here", "my-secret-key"), "token <redacted> here");
	assert.equal(redact("nothing to hide"), "nothing to hide");
});

test("loadKey takes the environment key first, trimmed", () => {
	const home = homeWithKey("sk-or-v1-from-the-file\n");
	try {
		assert.equal(
			loadKey({ OPENROUTER_API_KEY: `  ${KEY}\n` }, home),
			KEY,
		);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("loadKey reads the key file when the environment value is empty", () => {
	const home = homeWithKey(`  ${KEY}  \nsecond line ignored\n`);
	try {
		assert.equal(loadKey({ OPENROUTER_API_KEY: "   " }, home), KEY);
		assert.equal(loadKey({}, home), KEY);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("loadKey takes only the first line of the key file", () => {
	const home = homeWithKey("sk-or-v1-first\nsk-or-v1-second\n");
	try {
		assert.equal(loadKey({}, home), "sk-or-v1-first");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("loadKey is null when there is no key anywhere", () => {
	const home = homeWithKey(undefined);
	try {
		assert.equal(loadKey({}, home), null);
		assert.equal(loadKey({}, path.join(home, "missing")), null);
		assert.equal(loadKey({}, ""), null);
		assert.equal(loadKey({}, undefined), null);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("loadKey is null for an empty or blank key file", () => {
	const home = homeWithKey("\n   \n");
	try {
		assert.equal(loadKey({}, home), null);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("loadKey never throws when the key file cannot be read", () => {
	const home = homeWithKey(undefined);
	const file = path.join(home, ".config", "pi-plan-dispatch", "openrouter.key");
	fs.mkdirSync(file);
	try {
		assert.equal(loadKey({}, home), null);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("the fake backend records every request and returns the handler's result", async () => {
	const backend = fakeBackend((seen) => ({
		answers: { echo: { type: "noul", noul: seen.state.value } },
		usage: { input_tokens: 1, output_tokens: 2, cost: 0.5 },
		model: "fake-1",
	}));
	const first = { state: { value: 0.25 }, questions: {} };
	const second = { state: { value: 0.75 }, questions: {} };

	const one = await backend.ask(first);
	const two = await backend.ask(second);

	assert.equal(backend.name, "fake");
	assert.deepEqual(backend.calls, [first, second]);
	assert.equal(one.model, "fake-1");
	assert.equal(one.answers.echo.noul, 0.25);
	assert.equal(two.answers.echo.noul, 0.75);
});
