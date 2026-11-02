import { test, expect } from "bun:test";
import {
  MAX_HIGHLIGHT_CHARS,
  highlightHtml,
  languageFor,
  splitFences,
} from "./highlight";

test("languageFor maps every supported extension", () => {
  const cases: [string, string][] = [
    ["a.ts", "typescript"],
    ["a.tsx", "typescript"],
    ["a.mts", "typescript"],
    ["a.cts", "typescript"],
    ["a.js", "javascript"],
    ["a.jsx", "javascript"],
    ["a.mjs", "javascript"],
    ["a.cjs", "javascript"],
    ["a.go", "go"],
    ["a.json", "json"],
    ["a.md", "markdown"],
    ["a.markdown", "markdown"],
    ["a.sh", "bash"],
    ["a.bash", "bash"],
    ["a.zsh", "bash"],
    ["a.css", "css"],
    ["a.html", "xml"],
    ["a.htm", "xml"],
    ["a.xml", "xml"],
    ["a.svg", "xml"],
    ["a.yml", "yaml"],
    ["a.yaml", "yaml"],
    ["a.py", "python"],
    ["a.rs", "rust"],
    ["a.sql", "sql"],
    ["a.diff", "diff"],
    ["a.patch", "diff"],
  ];
  for (const [path, language] of cases) {
    expect(languageFor(path, "file")).toBe(language);
  }
});

test("languageFor lower-cases the extension and ignores the folder", () => {
  expect(languageFor("src/client/Highlight.TS", "file")).toBe("typescript");
  expect(languageFor("/tmp/a/b.md", "diff")).toBe("markdown");
});

test("languageFor returns null for an unknown extension", () => {
  expect(languageFor("notes.txt", "file")).toBeNull();
  expect(languageFor("Makefile", "file")).toBeNull();
});

test("languageFor returns null for a null path", () => {
  expect(languageFor(null, "file")).toBeNull();
  expect(languageFor(null, "diff")).toBeNull();
});

test("languageFor treats a command block as bash", () => {
  expect(languageFor("/a/script.unknownext", "command")).toBe("bash");
  expect(languageFor(null, "command")).toBe("bash");
});

test("highlightHtml escapes markup rather than letting it through", () => {
  const html = highlightHtml("<script>alert(1)</script>", "html");
  expect(html).not.toBeNull();
  expect(html as string).toContain("&lt;");
  expect(html as string).toContain("&gt;");
  expect(html as string).not.toContain("<script>");
});

test("highlightHtml returns null for too long a text", () => {
  const text = "const x = 1;\n".repeat(MAX_HIGHLIGHT_CHARS);
  expect(text.length).toBeGreaterThan(MAX_HIGHLIGHT_CHARS);
  expect(highlightHtml(text, "typescript")).toBeNull();
});

test("highlightHtml returns null for an unregistered language or a null language", () => {
  expect(highlightHtml("hello", "cobol")).toBeNull();
  expect(highlightHtml("hello", null)).toBeNull();
});

test("highlightHtml produces markup with an hljs- class for TypeScript", () => {
  const html = highlightHtml("const x: number = 1;", "typescript");
  expect(html).not.toBeNull();
  expect(html as string).toContain("hljs-");
});

test("highlightHtml accepts the library alias ts", () => {
  expect(highlightHtml("const x = 1", "ts")).not.toBeNull();
});

test("splitFences leaves a text without fences as one text segment", () => {
  expect(splitFences("plain text\nsecond line")).toEqual([
    { type: "text", text: "plain text\nsecond line", lang: null },
  ]);
});

test("splitFences splits one fence with a language", () => {
  expect(splitFences("before\n```ts\nconst x = 1\n```\nafter")).toEqual([
    { type: "text", text: "before", lang: null },
    { type: "code", text: "const x = 1", lang: "ts" },
    { type: "text", text: "after", lang: null },
  ]);
});

test("splitFences gives a fence without a language a null lang", () => {
  expect(splitFences("```\nplain\n```")).toEqual([
    { type: "code", text: "plain", lang: null },
  ]);
});

test("splitFences runs an unclosed fence to the end of the text", () => {
  expect(splitFences("intro\n```go\nfunc main() {}\n")).toEqual([
    { type: "text", text: "intro", lang: null },
    { type: "code", text: "func main() {}\n", lang: "go" },
  ]);
});

test("splitFences keeps the text between two fences", () => {
  expect(splitFences("```ts\na\n```\nmiddle\n```diff\n-b\n+c\n```")).toEqual([
    { type: "code", text: "a", lang: "ts" },
    { type: "text", text: "middle", lang: null },
    { type: "code", text: "-b\n+c", lang: "diff" },
  ]);
});

test("splitFences lower-cases the language and drops empty segments", () => {
  expect(splitFences("```TS\nx\n```\n\n```\ny\n```")).toEqual([
    { type: "code", text: "x", lang: "ts" },
    { type: "code", text: "y", lang: null },
  ]);
});

test("splitFences drops the blank lines around a fence", () => {
  expect(splitFences("\n```ts\nx\n```\n")).toEqual([
    { type: "code", text: "x", lang: "ts" },
  ]);
});
