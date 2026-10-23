import { resolve } from "node:path";
import { startServer } from "./server.ts";

interface Options {
  plansDir: string;
  staticDir: string;
  port: number;
  host: string;
}

const DEFAULTS: Options = {
  plansDir: "./.plans",
  port: 4317,
  host: "127.0.0.1",
  staticDir: resolve(import.meta.dir, "..", "..", "dist"),
};

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringOr(value: string | undefined, fallback: string): string {
  if (value === undefined || value === "") {
    return fallback;
  }
  return value;
}

function readOptions(argv: string[]): Options {
  const opts: Options = {
    plansDir: stringOr(process.env.PLANS_DIR, DEFAULTS.plansDir),
    port: numberOr(process.env.PORT, DEFAULTS.port),
    host: stringOr(process.env.HOST, DEFAULTS.host),
    staticDir: stringOr(process.env.STATIC_DIR, DEFAULTS.staticDir),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      break;
    }
    if (flag === "--plans") {
      opts.plansDir = value;
      i += 1;
    } else if (flag === "--port") {
      opts.port = numberOr(value, opts.port);
      i += 1;
    } else if (flag === "--host") {
      opts.host = value;
      i += 1;
    } else if (flag === "--static") {
      opts.staticDir = value;
      i += 1;
    }
  }

  return opts;
}

const opts = readOptions(process.argv.slice(2));
const server = startServer(opts);

console.log(`monitor on http://${opts.host}:${server.port}`);
