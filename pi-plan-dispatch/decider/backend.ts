/**
 * The backend adapter of the decider: an interface of `{ name, ask(request) }`
 * and two implementations, the OpenRouter Decisions endpoint and a fake used by
 * the tests. The endpoint is alpha, so its contract can change.
 *
 * No dependencies, Node built-ins and the global `fetch` only. Nothing here
 * prints, and the key never enters an error message: every message passes
 * through `redact` before it is stored.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const KEY_FILE = path.join(".config", "pi-plan-dispatch", "openrouter.key");
const KEY_PATTERN = /sk-or-[A-Za-z0-9_-]+/g;
const REDACTED = "<redacted>";
const RETRY_PAUSE_MS = 2000;
const ERROR_TEXT_MAX = 200;

const realSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

export interface BackendRequest {
	state: Record<string, unknown>;
	questions: Record<string, unknown>;
}

export interface BackendUsage {
	input_tokens: number;
	output_tokens: number;
	cost: number;
	[k: string]: unknown;
}

export interface BackendResult {
	answers: Record<string, unknown>;
	usage?: BackendUsage;
	model?: string;
	[k: string]: unknown;
}

export interface Backend {
	name: string;
	ask(req: BackendRequest): Promise<BackendResult>;
	calls?: BackendRequest[];
}

export type BackendErrorKind = "http" | "timeout" | "malformed";

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The first line of a text, trimmed; an empty string when there is no text. */
function firstLine(value: unknown): string {
	if (typeof value !== "string") return "";
	return (value.split(/\r?\n/u)[0] ?? "").trim();
}

/**
 * The inference key: `OPENROUTER_API_KEY` first, else the first line of
 * `<home>/.config/pi-plan-dispatch/openrouter.key`. Null when neither has one,
 * and never a throw for an unreadable file.
 */
export function loadKey(env: NodeJS.ProcessEnv, home: string): string | null {
	const fromEnv = firstLine(env?.OPENROUTER_API_KEY);
	if (fromEnv !== "") return fromEnv;
	if (typeof home !== "string" || home === "") return null;
	let text: string;
	try {
		text = fs.readFileSync(path.join(home, KEY_FILE), "utf8");
	} catch {
		return null;
	}
	const fromFile = firstLine(text);
	return fromFile === "" ? null : fromFile;
}

/** Every `sk-or-` token, and the exact key when it is passed, become `<redacted>`. */
export function redact(text: string, key?: string): string {
	let out = String(text);
	if (typeof key === "string" && key !== "") {
		out = out.split(key).join(REDACTED);
	}
	return out.replace(KEY_PATTERN, REDACTED);
}

/** A backend failure: `http` with the status (0 for no response), `timeout` or `malformed`. */
export class BackendError extends Error {
	status: number;
	kind: BackendErrorKind;

	constructor(
		message: string,
		{ status = 0, kind = "http" }: { status?: number; kind?: BackendErrorKind } = {},
	) {
		super(message);
		this.name = "BackendError";
		this.status = status;
		this.kind = kind;
	}
}

function isAbort(error: any): boolean {
	return (
		error?.name === "TimeoutError" ||
		error?.name === "AbortError" ||
		error?.code === "ABORT_ERR"
	);
}

function transportError(error: any, key: string): BackendError {
	if (isAbort(error)) {
		return new BackendError(redact("openrouter: the request timed out", key), {
			status: 0,
			kind: "timeout",
		});
	}
	const detail = typeof error?.message === "string" ? error.message : String(error);
	return new BackendError(redact(`openrouter: the request failed: ${detail}`, key), {
		status: 0,
		kind: "http",
	});
}

function retryable(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599);
}

/** The server's own message, one line and cut to 200 characters; never the request. */
async function errorText(response: Response): Promise<string> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return "";
	}
	let message = text;
	try {
		const parsed: unknown = JSON.parse(text);
		if (isObject(parsed) && isObject(parsed.error) && typeof parsed.error.message === "string") {
			message = parsed.error.message;
		}
	} catch {
		// Not JSON, so the raw body is the message.
	}
	return message.replace(/\s+/gu, " ").trim().slice(0, ERROR_TEXT_MAX);
}

async function httpError(response: Response, key: string): Promise<BackendError> {
	const message = await errorText(response);
	const suffix = message === "" ? "" : `: ${message}`;
	return new BackendError(redact(`openrouter: HTTP ${response.status}${suffix}`, key), {
		status: response.status,
		kind: "http",
	});
}

function usageOf(body: Record<string, unknown>): BackendUsage {
	const usage: Record<string, unknown> = isObject(body.usage) ? body.usage : {};
	return {
		input_tokens: numberOrZero(usage.input_tokens),
		output_tokens: numberOrZero(usage.output_tokens),
		cost: numberOrZero(usage.cost),
	};
}

async function readAnswer(response: Response, key: string): Promise<BackendResult> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new BackendError(redact("openrouter: the answer is not JSON", key), {
			status: response.status,
			kind: "malformed",
		});
	}
	if (!isObject(body) || !isObject(body.answers)) {
		throw new BackendError(redact("openrouter: the answer has no answers object", key), {
			status: response.status,
			kind: "malformed",
		});
	}
	return { answers: body.answers, usage: usageOf(body), model: body.model as string | undefined };
}

/**
 * The OpenRouter backend. One retry for 429 and 5xx, after `sleep(2000)`, which
 * the tests replace with an instant pause. `timeoutMs` bounds each attempt
 * through `AbortSignal.timeout`.
 */
export function openRouterBackend({
	key,
	model,
	timeoutMs = 30000,
	fetchImpl = fetch,
	sleep = realSleep,
}: {
	key: string;
	model: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
}): Backend {
	async function ask({ state, questions }: BackendRequest): Promise<BackendResult> {
		for (let attempt = 0; ; attempt += 1) {
			let response: Response;
			try {
				response = await fetchImpl(ENDPOINT, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${key}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ model, state, questions }),
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (error) {
				throw transportError(error, key);
			}
			if (response.ok) return readAnswer(response, key);
			const failure = await httpError(response, key);
			if (attempt === 0 && retryable(response.status)) {
				await sleep(RETRY_PAUSE_MS);
				continue;
			}
			throw failure;
		}
	}
	return { name: "openrouter", ask };
}

/** A backend for the tests: `handler(request)` gives the result, `calls` records every request. */
export function fakeBackend(
	handler: (request: BackendRequest) => BackendResult | Promise<BackendResult>,
): Backend & { calls: BackendRequest[] } {
	const calls: BackendRequest[] = [];
	return {
		name: "fake",
		calls,
		ask(request: BackendRequest): Promise<BackendResult> {
			calls.push(request);
			return Promise.resolve(handler(request));
		},
	};
}
