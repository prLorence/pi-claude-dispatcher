import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanup } from "../../test/fixture";
import { MAX_REPOS, resolveRepos } from "./repos.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-monitor-repos-"));
}

function dirs(repos: { dir: string }[]): string[] {
  return repos.map((repo) => repo.dir);
}

test("flags win over list, root and single", () => {
  const base = tempDir();
  try {
    const a = path.join(base, "a");
    const b = path.join(base, "b");
    const result = resolveRepos(
      {
        flags: [a],
        list: b,
        root: base,
        single: base,
      },
      base,
    );
    expect(result.repos.map((repo) => repo.name)).toEqual(["a"]);
    expect(dirs(result.repos)).toEqual([a]);
    expect(result.message).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("list wins over root and single", () => {
  const base = tempDir();
  try {
    const a = path.join(base, "a");
    const b = path.join(base, "b");
    const result = resolveRepos(
      { flags: [], list: [a, b].join(path.delimiter), root: base, single: base },
      base,
    );
    expect(result.repos.map((repo) => repo.name)).toEqual(["a", "b"]);
    expect(dirs(result.repos)).toEqual([a, b]);
  } finally {
    cleanup(base);
  }
});

test("root wins over single", () => {
  const base = tempDir();
  try {
    fs.mkdirSync(path.join(base, "one"));
    fs.mkdirSync(path.join(base, "two"));
    const result = resolveRepos({ flags: [], root: base, single: base }, base);
    expect(result.repos.map((repo) => repo.name)).toEqual(["one", "two"]);
  } finally {
    cleanup(base);
  }
});

test("single is the fallback and takes name=path", () => {
  const base = tempDir();
  try {
    const a = path.join(base, "a");
    const result = resolveRepos({ flags: [], single: `mine=${a}` }, base);
    expect(result.repos.map((repo) => repo.name)).toEqual(["mine"]);
    expect(dirs(result.repos)).toEqual([a]);
  } finally {
    cleanup(base);
  }
});

test("every configuration form is empty when nothing is configured", () => {
  const base = tempDir();
  try {
    const result = resolveRepos({ flags: [] }, base);
    expect(result.repos).toEqual([]);
    expect(result.message).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("an explicit name is used, a bad name text is a path", () => {
  const base = tempDir();
  try {
    const bad = `bad name=${path.join(base, "y")}`;
    const result = resolveRepos(
      { flags: [`good=${path.join(base, "x")}`, bad] },
      base,
    );
    expect(result.repos[0].name).toBe("good");
    // The whole text is the path, so the name falls back to its folder name.
    expect(result.repos[1].dir).toBe(path.resolve(base, bad));
    expect(result.repos[1].name).toBe("y");
  } finally {
    cleanup(base);
  }
});

test("a path ending in .plans is named after its parent folder", () => {
  const base = tempDir();
  try {
    const dir = path.join(base, "myrepo", ".plans");
    fs.mkdirSync(dir, { recursive: true });
    const result = resolveRepos({ flags: [dir] }, base);
    expect(result.repos[0].name).toBe("myrepo");
    expect(result.repos[0].dir).toBe(dir);
  } finally {
    cleanup(base);
  }
});

test("default names are sanitised", () => {
  const base = tempDir();
  try {
    const dir = path.join(base, "my repo");
    fs.mkdirSync(dir);
    expect(resolveRepos({ flags: [dir] }, base).repos[0].name).toBe("my-repo");
    expect(resolveRepos({ flags: ["/"] }, base).repos[0].name).toBe("repo");
    expect(resolveRepos({ flags: ["/.plans"] }, base).repos[0].name).toBe("repo");
  } finally {
    cleanup(base);
  }
});

test("a root lists its subfolders sorted, skipping dot folders and files", () => {
  const base = tempDir();
  try {
    fs.mkdirSync(path.join(base, "b"));
    fs.mkdirSync(path.join(base, "a"));
    fs.mkdirSync(path.join(base, ".hidden"));
    fs.writeFileSync(path.join(base, "file.txt"), "");
    const result = resolveRepos({ flags: [], root: base }, base);
    expect(result.repos.map((repo) => repo.name)).toEqual(["a", "b"]);
    expect(dirs(result.repos)).toEqual([
      path.join(base, "a"),
      path.join(base, "b"),
    ]);
  } finally {
    cleanup(base);
  }
});

test("a root that is itself a plans folder is one repo, any marker alone", () => {
  const base = tempDir();
  try {
    for (const marker of ["traces", "running", "done", "inbox", "sessions"]) {
      const root = path.join(base, marker);
      fs.mkdirSync(path.join(root, marker), { recursive: true });
      fs.mkdirSync(path.join(root, "ignored-subfolder"));
      const result = resolveRepos({ flags: [], root }, base);
      expect(result.repos.map((repo) => repo.name)).toEqual([marker]);
      expect(dirs(result.repos)).toEqual([root]);
    }
  } finally {
    cleanup(base);
  }
});

test("duplicate names become name-2, name-3", () => {
  const base = tempDir();
  try {
    const result = resolveRepos(
      {
        flags: [
          `dup=${path.join(base, "one")}`,
          `dup=${path.join(base, "two")}`,
          `dup=${path.join(base, "three")}`,
        ],
      },
      base,
    );
    expect(result.repos.map((repo) => repo.name)).toEqual([
      "dup",
      "dup-2",
      "dup-3",
    ]);
  } finally {
    cleanup(base);
  }
});

test("more than the cap is cut with a message", () => {
  const base = tempDir();
  try {
    const flags: string[] = [];
    for (let i = 0; i < MAX_REPOS + 3; i += 1) {
      flags.push(path.join(base, `r${i}`));
    }
    const result = resolveRepos({ flags }, base);
    expect(result.repos.length).toBe(MAX_REPOS);
    expect(result.message).toBe("3 more repos ignored (limit 24)");
  } finally {
    cleanup(base);
  }
});

test("a missing folder is still a repo and an unreadable root gives none", () => {
  const base = tempDir();
  try {
    const missing = path.join(base, "missing");
    const result = resolveRepos({ flags: [missing] }, base);
    expect(result.repos).toEqual([{ name: "missing", dir: missing }]);

    const unreadable = resolveRepos(
      { flags: [], root: path.join(base, "nope") },
      base,
    );
    expect(unreadable.repos).toEqual([]);
    expect(unreadable.message).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("relative paths resolve against the given cwd", () => {
  const base = tempDir();
  try {
    fs.mkdirSync(path.join(base, "sub"));
    const result = resolveRepos({ flags: ["rel", "named=sub"] }, base);
    expect(dirs(result.repos)).toEqual([
      path.join(base, "rel"),
      path.join(base, "sub"),
    ]);
    expect(result.repos[1].name).toBe("named");
  } finally {
    cleanup(base);
  }
});
