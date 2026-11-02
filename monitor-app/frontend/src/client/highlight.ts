import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("go", go);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml); // also covers html through its own aliases
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("diff", diff);

export const MAX_HIGHLIGHT_CHARS = 40000;

const EXTENSIONS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  go: "go",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  css: "css",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  yml: "yaml",
  yaml: "yaml",
  py: "python",
  rs: "rust",
  sql: "sql",
  diff: "diff",
  patch: "diff",
};

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function languageFor(path: string | null, kind: string): string | null {
  if (kind === "command") return "bash";
  if (!path) return null;
  return EXTENSIONS[extensionOf(path)] ?? null;
}

export function highlightHtml(text: string, language: string | null): string | null {
  if (!language) return null;
  if (!hljs.getLanguage(language)) return null;
  if (text.length > MAX_HIGHLIGHT_CHARS) return null;
  return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}

export interface FenceSegment {
  type: "text" | "code";
  text: string;
  lang: string | null;
}

// A fence opens on a line starting with three backticks and an optional language word, and
// closes on the next such line. A fence with no closing line runs to the end of the text.
export function splitFences(text: string): FenceSegment[] {
  const lines = text.split(/\r?\n/);
  const segments: FenceSegment[] = [];
  let buffer: string[] = [];
  let inCode = false;
  let lang: string | null = null;

  const flushText = () => {
    const body = buffer.join("\n");
    if (body.length > 0) segments.push({ type: "text", text: body, lang: null });
  };

  for (const line of lines) {
    if (!line.startsWith("```")) {
      buffer.push(line);
      continue;
    }
    if (inCode) {
      segments.push({ type: "code", text: buffer.join("\n"), lang });
      buffer = [];
      inCode = false;
      lang = null;
    } else {
      flushText();
      buffer = [];
      inCode = true;
      const word = line.slice(3).trim().split(/\s+/)[0];
      lang = word ? word.toLowerCase() : null;
    }
  }

  if (inCode) {
    segments.push({ type: "code", text: buffer.join("\n"), lang });
  } else {
    flushText();
  }
  return segments;
}
