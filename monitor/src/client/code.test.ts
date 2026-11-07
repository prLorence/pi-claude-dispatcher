import { expect, test } from "bun:test";
import { highlightCode, languageFromPath, normalizeLanguage, splitFences } from "./code";

test("highlights a known language", () => {
  const result = highlightCode("const answer: number = 42", "typescript");
  expect(result.language).toBe("typescript");
  expect(result.html).toContain("hljs-keyword");
  expect(result.html).toContain("hljs-number");
});

test("escapes code instead of injecting markup", () => {
  const result = highlightCode("<script>alert('x')</script>", "html");
  expect(result.html).not.toContain("<script>");
  expect(result.html).toContain("&lt;");
});

test("normalizes language aliases and path extensions", () => {
  expect(normalizeLanguage("ts")).toBe("typescript");
  expect(normalizeLanguage("bash")).toBe("bash");
  expect(languageFromPath('{"path":"src/app.tsx"}')).toBe("typescript");
  expect(languageFromPath("README.md")).toBe("markdown");
  expect(languageFromPath("Makefile")).toBeNull();
});

test("splits fenced code from prose", () => {
  const parts = splitFences("before\n```js\nconst x = 1;\n```\nafter");
  expect(parts).toHaveLength(3);
  expect(parts[1].code?.language).toBe("javascript");
  expect(parts[1].code?.code).toBe("const x = 1;");
});
