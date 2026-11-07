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

const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash,
  css,
  diff,
  go,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition);

const ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  html: "xml",
  htm: "xml",
  svg: "xml",
  md: "markdown",
  yml: "yaml",
  py: "python",
  rs: "rust",
  golang: "go",
};

const EXTENSIONS: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  json: "json",
  css: "css",
  scss: "css",
  html: "xml",
  htm: "xml",
  svg: "xml",
  md: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  go: "go",
  rs: "rust",
  sql: "sql",
  diff: "diff",
  patch: "diff",
};

const AUTO = Object.keys(LANGUAGES);

export interface Highlight {
  html: string;
  language: string | null;
}

export function normalizeLanguage(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = value.toLowerCase().replace(/^language-/, "").trim();
  const language = ALIASES[key] ?? key;
  return Object.hasOwn(LANGUAGES, language) ? language : null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Highlight known code; plain text stays escaped rather than getting random token colors. */
export function highlightCode(source: string, language?: string | null): Highlight {
  const named = normalizeLanguage(language);
  if (named !== null) {
    return { html: hljs.highlight(source, { language: named, ignoreIllegals: true }).value, language: named };
  }
  const auto = hljs.highlightAuto(source, AUTO);
  if (auto.relevance >= 5) return { html: auto.value, language: auto.language ?? null };
  return { html: escapeHtml(source), language: null };
}

/** Infer a language from a tool path in its JSON arguments. */
export function languageFromPath(value: string): string | null {
  const match = value.match(/(?:[A-Za-z]:)?[\\/]?[\w@.+/-]*\.([A-Za-z0-9]+)\b/);
  if (match === null) return null;
  return EXTENSIONS[match[1].toLowerCase()] ?? null;
}

export interface Fence {
  language: string | null;
  code: string;
}

/** Split assistant/user text into prose and fenced code. */
export function splitFences(text: string): { text: string; code: Fence | null }[] {
  const parts: { text: string; code: Fence | null }[] = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), code: null });
    parts.push({ text: "", code: { language: normalizeLanguage(match[1]), code: match[2].replace(/\n$/, "") } });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ text: text.slice(last), code: null });
  return parts.length === 0 ? [{ text, code: null }] : parts;
}
