/**
 * Host half of the Mistral subscription settings surface.
 *
 * Serves two routes to the Client half and runs authorization attempts on
 * demand:
 *
 * - GET  /plugins/mistral-subscription/state  — whether the credential record
 *   exists and whether an attempt is running.
 * - POST /plugins/mistral-subscription/sign-in — starts one authorization
 *   attempt; the response settles when the attempt ends.
 * - POST /plugins/mistral-subscription/sign-out — deletes the record.
 *
 * The key never crosses these routes: state is boolean, and errors carry no
 * token material.
 */

const STATE_PATH = "/plugins/mistral-subscription/state";
const SIGN_IN_PATH = "/plugins/mistral-subscription/sign-in";
const SIGN_OUT_PATH = "/plugins/mistral-subscription/sign-out";

/** Record this plugin manages. Must match lib/index.js. */
import { createFlow } from "./index.js";

const FLOW_KEY = "llm-pi-ai/mistral-subscription";


function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

async function readBody(res) {
	const chunks = [];
	for await (const chunk of res) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString("utf-8");
	if (raw.length === 0) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

/** Registers the settings routes and the flow. Returns a disposer. */
export async function registerWebRoutes(ctx) {
	const disposers = [];

	// Outcome of the most recent attempt, surfaced through /state.
	let lastOutcome = null;
	let lastError = null;

	// The flow lives here too: one apply per package, and this package's apply
	// (in index.js) delegates to this function. The flow and the routes share
	// the same key and the same credential service.
	const flow = createFlow({
		key: FLOW_KEY,
		credentials: ctx.credentials,
	});
	const disposeFlow = ctx.authorization.registerFlow(flow);
	disposers.push(disposeFlow);

	disposers.push(
		ctx.webServer.register({
			kind: "exact",
			path: STATE_PATH,
			handler: async (req, res) => {
				let configured = false;
				let inFlight = false;
				try {
					const info = ctx.authorization.describe(FLOW_KEY);
					inFlight = info?.inFlight === true;
				} catch {}
				try {
					const record = await ctx.credentials.readRecord(FLOW_KEY);
					configured = record !== undefined && record !== null;
				} catch {}
				sendJson(res, 200, {
					configured,
					inFlight,
					key: FLOW_KEY,
					outcome: lastOutcome,
					error: lastError,
				});
			},
		}),
	);

	disposers.push(
		ctx.webServer.register({
			kind: "exact",
			path: SIGN_IN_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") {
					sendJson(res, 405, { error: "POST only" });
					return;
				}
				void readBody(req).catch(() => ({}));
				// The browser URL arrives through the session notification, which the
				// flow raises before polling. Start the attempt without awaiting it,
				// respond with the URL as soon as the notification lands, and let the
				// attempt settle in the background; the client polls /state for the
				// outcome and navigates (or shows) the URL itself.
				let authorizeUrl;
				try {
					const attempt = ctx.authorization
						.begin({
							key: FLOW_KEY,
							interaction: {
								notify: (n) => {
									if (n && typeof n.url === "string") authorizeUrl = n.url;
								},
								prompt: () => Promise.reject(new Error("UNSUPPORTED")),
							},
						})
						.then((outcome) => {
							lastOutcome = outcome?.status ?? "unknown";
							return outcome;
						})
						.catch((error) => {
							lastError = String(error?.code ?? error?.name ?? "error");
							lastOutcome = "failed";
						});
					void attempt;
					// The notify fires synchronously inside begin() before the flow
					// reaches its first await, but the seam may defer the call. Give
					// the microtask queue a beat, then answer.
					for (let i = 0; i < 50 && authorizeUrl === undefined; i++) {
						await new Promise((r) => setTimeout(r, 20));
					}
					if (authorizeUrl === undefined) {
						sendJson(res, 200, { started: false, error: "NO_URL" });
						return;
					}
					sendJson(res, 200, { started: true, url: authorizeUrl });
				} catch (error) {
					const code = error?.code ?? error?.name ?? "error";
					// No token material in any error path.
					sendJson(res, 400, { started: false, error: String(code) });
				}
			},
		}),
	);

	disposers.push(
		ctx.webServer.register({
			kind: "exact",
			path: SIGN_OUT_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") {
					sendJson(res, 405, { error: "POST only" });
					return;
				}
				try {
					await ctx.credentials.deleteRecord(FLOW_KEY);
					sendJson(res, 200, { status: "signed-out" });
				} catch (error) {
					sendJson(res, 400, { status: "failed", error: String(error?.code ?? "error") });
				}
			},
		}),
	);

	return () => {
		for (const d of disposers) {
			try {
				d();
			} catch {}
		}
	};
}
