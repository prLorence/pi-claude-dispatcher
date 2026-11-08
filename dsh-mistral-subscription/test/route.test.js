import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Offline structural check of route.example.yml.
 *
 * No YAML dependency is available on any resolution path (the plugin ships no
 * node_modules), so this file carries a small reader for the YAML subset the
 * route file uses: block mappings, block sequences and plain scalars. The
 * authoritative parse is the PyYAML check in the task's verify line; this
 * reader is the always-runnable guarantee. It throws on anything outside the
 * subset instead of guessing, so a structural mistake in the file surfaces
 * here as a failure rather than a silent skip.
 */
const ROUTE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "route.example.yml");

/** A '#' opens a comment at line start or after whitespace, never inside quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** Indent/content pairs, comments and blank lines removed. */
function tokenize(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    const stripped = stripComment(raw);
    if (!stripped.trim()) continue;
    const indent = stripped.length - stripped.trimStart().length;
    if (stripped.slice(0, indent).includes("\t")) throw new Error("tab indentation is not valid YAML");
    lines.push({ indent, text: stripped.trimEnd().slice(indent) });
  }
  return lines;
}

/**
 * Plain scalar only. Flow collections (`[a, b]`, `{a: b}`) are rejected rather
 * than degraded to a string: the route file uses block sequences so that both
 * this reader and PyYAML see the same structure, and a silent downgrade would
 * hide exactly the kind of mistake this test exists to catch.
 */
function scalar(text) {
  if (text.startsWith("[") || text.startsWith("{")) {
    throw new Error(`flow collections are outside this reader's subset: "${text}"`);
  }
  if (text === "false") return false;
  if (text === "true") return true;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const quoted = /^(["'])(.*)\1$/.exec(text);
  return quoted ? quoted[2] : text;
}

const KEY_LINE = /^([A-Za-z0-9_.$-]+):(?: (.*))?$/;
const isItem = (text) => text === "-" || text.startsWith("- ");

function parseNode(lines, start) {
  const { indent, text } = lines[start];
  return isItem(text) ? parseSequence(lines, start, indent) : parseMapping(lines, start, indent);
}

/** `seed` carries the inline first pair of a "- key: value" sequence item. */
function parseMapping(lines, start, indent, seed = null) {
  const map = {};
  let i = start;
  let pending = seed;
  for (;;) {
    let lineText;
    if (pending) {
      lineText = pending.text;
      pending = null;
    } else if (i < lines.length && lines[i].indent === indent) {
      lineText = lines[i].text;
      i += 1;
    } else {
      break;
    }
    const match = KEY_LINE.exec(lineText);
    if (!match) throw new Error(`cannot read mapping line: "${lineText}"`);
    const [, key, inline] = match;
    if (inline !== undefined && inline !== "") {
      map[key] = scalar(inline);
    } else if (i < lines.length && lines[i].indent > indent) {
      const [value, next] = parseNode(lines, i);
      map[key] = value;
      i = next;
    } else {
      map[key] = null;
    }
  }
  return [map, i];
}

function parseSequence(lines, start, indent) {
  const list = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && isItem(lines[i].text)) {
    const rest = lines[i].text === "-" ? "" : lines[i].text.slice(2).trim();
    i += 1;
    if (!rest) {
      if (i < lines.length && lines[i].indent > indent) {
        const [value, next] = parseNode(lines, i);
        list.push(value);
        i = next;
      } else {
        list.push(null);
      }
    } else if (KEY_LINE.test(rest)) {
      const childIndent = i < lines.length && lines[i].indent > indent ? lines[i].indent : indent + 2;
      const [value, next] = parseMapping(lines, i, childIndent, { text: rest });
      list.push(value);
      i = next;
    } else {
      list.push(scalar(rest));
    }
  }
  return [list, i];
}

function parseYaml(text) {
  const lines = tokenize(text);
  assert.ok(lines.length > 0, "route.example.yml is empty");
  const [doc, consumed] = parseNode(lines, 0);
  assert.equal(consumed, lines.length, `unparsed tail at "${lines[consumed]?.text}"`);
  return doc;
}

const text = await readFile(ROUTE_PATH, "utf8");
const doc = parseYaml(text);

const entry = (id) => {
  const found = doc.find((item) => item && item.id === id);
  assert.ok(found, `missing settings entry: ${id}`);
  return found;
};

const route = entry("llm-pi-ai").config.providers["mistral-subscription"];

const EXPECTED_MODELS = [
  {
    id: "deepseek-v4-1-flash-1017",
    contextWindow: 1048576,
    maxTokens: 32768,
    input: ["text", "image"],
    reasoningEfforts: { off: "none", low: "low", high: "high", xhigh: "xhigh", max: "max" },
  },
  // GLM trio: text-only (image unverified through this route), served via
  // the normalizer's shape-keyed content-block translation.
  {
    id: "zai-glm-5-3",
    contextWindow: 1048576,
    maxTokens: 32768,
    input: ["text"],
    reasoningEfforts: { low: "low", high: "high", max: "max" },
  },
  {
    id: "zai-glm-5-3-flash",
    contextWindow: 1048576,
    maxTokens: 32768,
    input: ["text"],
    reasoningEfforts: { low: "low", high: "high", max: "max" },
  },
  {
    id: "glm-5-2",
    contextWindow: 1048576,
    maxTokens: 32768,
    input: ["text"],
    reasoningEfforts: { off: "none", low: "low", high: "high", max: "max" },
  },
  {
    id: "mistral-medium-2604",
    contextWindow: 262144,
    maxTokens: 32768,
    input: ["text", "image"],
    reasoningEfforts: { off: "none", high: "high" },
  },
  {
    id: "mistral-small-latest",
    contextWindow: 262144,
    maxTokens: 32768,
    input: ["text", "image"],
    reasoningEfforts: { off: "none", high: "high" },
  },
  {
    id: "ministral-14b-2512",
    contextWindow: 262144,
    maxTokens: 32768,
    input: ["text", "image"],
    reasoningEfforts: false,
  },
  {
    id: "ministral-8b-2512",
    contextWindow: 262144,
    maxTokens: 32768,
    input: ["text", "image"],
    reasoningEfforts: false,
  },
  {
    id: "ministral-3b-2512",
    contextWindow: 131072,
    maxTokens: 32768,
    input: ["text", "image"],
    reasoningEfforts: false,
  },
  {
    id: "codestral-2508",
    contextWindow: 256000,
    maxTokens: 32768,
    input: ["text"],
    reasoningEfforts: false,
  },
];

test("route.example.yml is a single YAML document holding the entry list", () => {
  assert.ok(Array.isArray(doc), "top level must be a list of settings entries");
  assert.deepEqual(
    doc.map((item) => item.id),
    ["llm-pi-ai", "subagent-model-selection-settings"],
  );
  assert.ok(!text.includes("```"), "no markdown fences");
  const separators = text.split("\n").filter((line) => /^---\s*$/.test(line));
  assert.deepEqual(separators, [], "no second YAML document separator");
});

test("provider keeps the openai-completions route with the compat overrides", () => {
  assert.equal(route.api, "openai-completions");
  // Through the plugin's localhost normalizer, not the origin: it strips
  // reasoning fields pi-ai replays from other providers' history (422 fix).
  assert.equal(route.baseURL, "http://127.0.0.1:8477/v1");
  assert.deepEqual(route.compat, {
    supportsStore: false,
    supportsDeveloperRole: false,
    // reasoning_effort is a top-level string now (probed 2026-11-08).
    supportsReasoningEffort: true,
  });
});

test("active model set matches, deepseek-v4-1-flash-1017 first", () => {
  assert.deepEqual(route.models, EXPECTED_MODELS);
  assert.equal(route.models[0].id, "deepseek-v4-1-flash-1017");
});

test("GLM models are translated by the normalizer, mistral-large-4 is not advertised", () => {
  const ids = route.models.map((model) => model.id);
  // GLM family IS advertised now — the proxy translates its content blocks.
  assert.deepEqual(ids.filter((id) => id.startsWith("zai-glm") || id === "glm-5-2"), [
    "zai-glm-5-3",
    "zai-glm-5-3-flash",
    "glm-5-2",
  ]);
  assert.ok(!ids.includes("mistral-large-4"), "mistral-large-4 streams arrays");
  assert.ok(!ids.includes("mistral-large-2512"), "mistral-large-2512 is unverified and held out");
});

test("non-reasoning models keep reasoningEfforts: false", () => {
  for (const model of route.models) {
    assert.ok(
      Object.hasOwn(model, "reasoningEfforts"),
      `${model.id} must declare reasoningEfforts explicitly`,
    );
    if (/^(ministral|codestral)/.test(model.id)) {
      // "reasoning_effort is not enabled for this model" — keep them off.
      assert.equal(model.reasoningEfforts, false, `${model.id} must disable the reasoning ladder`);
    }
  }
});

test("reasoning ladders are the live-verified per-model sets", () => {
  const ladders = Object.fromEntries(
    route.models.filter((model) => model.reasoningEfforts !== false).map((model) => [model.id, model.reasoningEfforts]),
  );
  assert.deepEqual(ladders, {
    "deepseek-v4-1-flash-1017": { off: "none", low: "low", high: "high", xhigh: "xhigh", max: "max" },
    // zai: no `off` — "none" does not disable GLM thinking.
    "zai-glm-5-3": { low: "low", high: "high", max: "max" },
    "zai-glm-5-3-flash": { low: "low", high: "high", max: "max" },
    "glm-5-2": { off: "none", low: "low", high: "high", max: "max" },
    "mistral-medium-2604": { off: "none", high: "high" },
    "mistral-small-latest": { off: "none", high: "high" },
  });
  // Every level but `off` carries a wire string; every ladder offers one.
  for (const [id, ladder] of Object.entries(ladders)) {
    assert.ok(Object.keys(ladder).some((level) => level !== "off"), `${id} offers no level beyond off`);
  }
});

test("subagent allowlist pins the primary model only", () => {
  const settings = entry("subagent-model-selection-settings").config;
  assert.deepEqual(settings.allowedModels, [
    { provider: "mistral-subscription", model: "deepseek-v4-1-flash-1017" },
  ]);
});

test("route file records the full inventory and both follow-ups", () => {
  for (const canonical of [
    "mistral-large-2512",
    "mistral-large-4",
    "glm-5-2",
    "zai-glm-5-3",
    "zai-glm-5-3-flash",
    "labs-leanstral-1-5-1",
    "Voxtral Small Transcribe",
  ]) {
    assert.ok(text.includes(canonical), `inventory must name ${canonical}`);
  }
  assert.match(text, /INVENTORY/, "inventory block must be labelled");
  assert.match(text, /mistral-conversations/, "must point at the protocol follow-up");
  assert.match(text, /UNVERIFIED|unverified/, "must flag the unprobed model");
});
