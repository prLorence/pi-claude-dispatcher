import { expect, mock, test } from "bun:test";

const stateCalls: number[] = [];
const sessionCalls: [string, string, string, number][] = [];
const eventNames: string[] = [];
const listeners: (() => void)[] = [];
let offCalls = 0;
let cancelCalls = 0;

const cancel = (): void => {
  cancelCalls += 1;
};

const statePage = { repos: [], message: null, now: "2026-11-02T00:00:00.000Z" };
const sessionPage = { id: "s1", live: false, ended: true, entries: [], next: 4 };

mock.module("../../wailsjs/go/main/App", () => ({
  State: async () => {
    stateCalls.push(1);
    return statePage;
  },
  Session: async (repo: string, plan: string, id: string, after: number) => {
    sessionCalls.push([repo, plan, id, after]);
    return sessionPage;
  },
  AddRepo: async () => "",
  RemoveRepo: async () => "",
}));

mock.module("../../wailsjs/runtime/runtime", () => ({
  EventsOn: (name: string, callback: () => void) => {
    eventNames.push(name);
    listeners.push(callback);
    return cancel;
  },
  EventsOff: () => {
    offCalls += 1;
  },
}));

const { fetchSession, fetchState, subscribe } = await import("./api");

test("the first state load comes from the Go State binding", async () => {
  stateCalls.length = 0;
  const state = await fetchState();
  expect(stateCalls).toHaveLength(1);
  expect(state).toBe(statePage);
});

test("fetchSession forwards the repo, plan, id and after cursor unencoded", async () => {
  sessionCalls.length = 0;
  const page = await fetchSession("dfph-app", "plan/1", "a 1", 4);
  expect(sessionCalls).toHaveLength(1);
  expect(sessionCalls[0]).toEqual(["dfph-app", "plan/1", "a 1", 4]);
  expect(page).toBe(sessionPage);
});

test("subscribe listens for change and returns the canceller EventsOn gives", () => {
  eventNames.length = 0;
  listeners.length = 0;
  let changes = 0;
  const off = subscribe(() => {
    changes += 1;
  });
  expect(eventNames).toEqual(["change"]);
  expect(off).toBe(cancel);
  listeners[0]();
  expect(changes).toBe(1);
});

test("subscribe never calls EventsOff", () => {
  offCalls = 0;
  cancelCalls = 0;
  const off = subscribe(() => {});
  off();
  expect(cancelCalls).toBe(1);
  expect(offCalls).toBe(0);
});
