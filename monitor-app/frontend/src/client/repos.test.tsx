import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let addMessage = "";
let removeMessage = "";
let addCalls = 0;
const removed: string[] = [];

mock.module("../../wailsjs/go/main/App", () => ({
  State: async () => ({ repos: [], message: null, now: "2026-11-02T00:00:00.000Z" }),
  Session: async () => ({ id: "", live: false, ended: true, entries: [], next: 0 }),
  AddRepo: async () => {
    addCalls += 1;
    return addMessage;
  },
  RemoveRepo: async (name: string) => {
    removed.push(name);
    return removeMessage;
  },
}));

const { Repos, handleAdd, handleRemove } = await import("./Repos");

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("the header always offers Add repo and one Remove control per repo", () => {
  const html = renderToStaticMarkup(<Repos names={["alpha", "beta"]} />);
  expect(html).toContain("Add repo");
  expect(count(html, 'class="repos-remove"')).toBe(2);
  expect(html).toContain('aria-label="Remove alpha"');
  expect(html).toContain('aria-label="Remove beta"');
  expect(html).toContain("alpha");
  expect(html).toContain("beta");
});

test("the header offers Add repo when no repo is configured", () => {
  const html = renderToStaticMarkup(<Repos names={[]} />);
  expect(html).toContain("Add repo");
  expect(count(html, 'class="repos-remove"')).toBe(0);
});

test("handleAdd returns the binding message for a flag repo", async () => {
  addMessage = "repos come from --plans flags";
  addCalls = 0;
  expect(await handleAdd()).toBe("repos come from --plans flags");
  expect(addCalls).toBe(1);
});

test("handleAdd returns an empty message on success", async () => {
  addMessage = "";
  expect(await handleAdd()).toBe("");
});

test("handleRemove forwards the name and returns an empty message on success", async () => {
  removed.length = 0;
  removeMessage = "";
  expect(await handleRemove("beta")).toBe("");
  expect(removed).toEqual(["beta"]);
});

test("handleRemove returns the binding message for an unknown name", async () => {
  removed.length = 0;
  removeMessage = "no saved repo named beta";
  expect(await handleRemove("beta")).toBe("no saved repo named beta");
  expect(removed).toEqual(["beta"]);
});
