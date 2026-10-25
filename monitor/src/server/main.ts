import { resolve } from "node:path";
import { resolveRepos, type RepoInput } from "./repos.ts";
import { startServer } from "./server.ts";

interface Options {
  repos: { name: string; dir: string }[];
  message: string | null;
  staticDir: string;
  port: number;
  host: string;
}

const DEFAULTS = {
  port: 4317,
  host: "127.0.0.1",
  staticDir: resolve(import.meta.dir, "..", "..", "dist"),
  single: "./.plans",
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

function readRepoInput(argv: string[]): RepoInput {
  const flags: string[] = [];
  let root: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      break;
    }
    if (flag === "--plans") {
      flags.push(value);
      i += 1;
    } else if (flag === "--plans-root") {
      root = value;
      i += 1;
    }
  }

  const input: RepoInput = { flags };
  const list = process.env.PLANS_DIRS;
  if (list !== undefined && list !== "") {
    input.list = list;
  }
  const envRoot = root ?? process.env.PLANS_ROOT;
  if (envRoot !== undefined && envRoot !== "") {
    input.root = envRoot;
  }
  const envSingle = process.env.PLANS_DIR;
  input.single = envSingle !== undefined && envSingle !== "" ? envSingle : DEFAULTS.single;
  return input;
}

function readOptions(argv: string[]): Options {
  const resolved = resolveRepos(readRepoInput(argv));
  const opts: Options = {
    repos: resolved.repos,
    message: resolved.message,
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
    if (flag === "--port") {
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
for (const repo of opts.repos) {
  console.log(`repo ${repo.name}`);
}
if (opts.message !== null) {
  console.log(opts.message);
}
