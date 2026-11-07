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
				sendJson(res, 200, { configured, inFlight, key: FLOW_KEY });
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
				const origin = `http://127.0.0.1:${req.socket.localPort ?? ""}`;
				void readBody(req).catch(() => ({}));
				try {
					const outcome = await ctx.authorization.begin({
						key: FLOW_KEY,
						interaction: {
							notify: () => void 0,
							prompt: () => Promise.reject(new Error("UNSUPPORTED")),
						},
					});
					sendJson(res, 200, {
						status: outcome?.status ?? "unknown",
						message:
							outcome?.status === "authorized"
								? "Signed in. Mistral requests now bill to the subscription."
								: "Sign-in did not complete.",
					});
				} catch (error) {
					const code = error?.code ?? error?.name ?? "error";
					// No token material in any error path.
					sendJson(res, 400, { status: "failed", error: String(code) });
				}
				void origin;
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
