import * as fs from "node:fs";
import * as path from "node:path";

export interface RepoConfig {
  name: string;
  dir: string;
}

export interface RepoInput {
  flags: string[];
  list?: string;
  root?: string;
  single?: string;
}

export const MAX_REPOS = 24;

const NAME_RE = /^[\w.-]+$/;
const MARKERS = ["traces", "running", "done", "inbox", "sessions"];

interface Entry {
  name: string | null;
  dir: string;
}

/** Folder name of a resolved path; "" when the path has no usable name. */
function folderName(dir: string): string {
  const base = path.basename(dir);
  if (base === "" || base === path.sep || base === ".") {
    return "";
  }
  return base;
}

/** Every character outside [\w.-] becomes "-"; an empty result becomes "repo". */
function sanitize(raw: string): string {
  const cleaned = raw.replace(/[^\w.-]/g, "-");
  return cleaned === "" ? "repo" : cleaned;
}

function defaultName(dir: string): string {
  if (path.basename(dir) === ".plans") {
    return sanitize(folderName(path.dirname(dir)));
  }
  return sanitize(folderName(dir));
}

/** A spec is `[name=]<path>`; the text before the first "=" is a name only when it matches. */
function parseSpec(text: string): { name: string | null; value: string } {
  const eq = text.indexOf("=");
  if (eq > 0) {
    const candidate = text.slice(0, eq);
    const rest = text.slice(eq + 1);
    if (NAME_RE.test(candidate) && rest !== "") {
      return { name: candidate, value: rest };
    }
  }
  return { name: null, value: text };
}

function specEntry(spec: string, cwd: string): Entry {
  const parsed = parseSpec(spec);
  return { name: parsed.name, dir: path.resolve(cwd, parsed.value) };
}

function listSpecs(list: string): string[] {
  return list
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function rootEntries(root: string, cwd: string): Entry[] {
  const abs = path.resolve(cwd, root);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(abs).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return [];
  }

  if (MARKERS.some((marker) => fs.existsSync(path.join(abs, marker)))) {
    return [{ name: null, dir: abs }];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }

  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return folders.map((name) => ({ name: null, dir: path.join(abs, name) }));
}

function uniqueName(base: string, seen: Map<string, number>): string {
  const current = seen.get(base);
  if (current === undefined) {
    seen.set(base, 1);
    return base;
  }
  let n = current + 1;
  while (seen.has(`${base}-${n}`)) {
    n += 1;
  }
  seen.set(base, n);
  const candidate = `${base}-${n}`;
  seen.set(candidate, 1);
  return candidate;
}

export function resolveRepos(
  input: RepoInput,
  cwd: string = process.cwd(),
): { repos: RepoConfig[]; message: string | null } {
  const base = path.resolve(cwd);
  const flags = input.flags ?? [];
  let entries: Entry[] = [];

  if (flags.length > 0) {
    entries = flags.map((flag) => specEntry(flag, base));
  } else if (input.list !== undefined && input.list !== "") {
    entries = listSpecs(input.list).map((item) => specEntry(item, base));
  } else if (input.root !== undefined && input.root !== "") {
    entries = rootEntries(input.root, base);
  } else if (input.single !== undefined && input.single !== "") {
    entries = [specEntry(input.single, base)];
  }

  const seen = new Map<string, number>();
  const all: RepoConfig[] = entries.map((entry) => {
    const name = uniqueName(entry.name ?? defaultName(entry.dir), seen);
    return { name, dir: entry.dir };
  });

  const repos = all.slice(0, MAX_REPOS);
  const extra = all.length - repos.length;
  const message =
    extra > 0 ? `${extra} more repos ignored (limit ${MAX_REPOS})` : null;

  return { repos, message };
}
