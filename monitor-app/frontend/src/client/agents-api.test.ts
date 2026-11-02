import { expect, mock, test } from "bun:test";

const settingsCalls: number[] = [];
const setSettingsCalls: { ompSessions: boolean; piSessions: boolean; scope: string }[] = [];
const agentsCalls: number[] = [];
const agentSessionCalls: [string, string, string, number][] = [];

const settingsValue = { ompSessions: true, piSessions: false, scope: "repos" as const };
const agentGroups = [
  {
    name: "demo",
    sessions: [
      {
        agent: "omp",
        id: "s1",
        title: "A session",
        model: "demo-model",
        cwd: "/tmp/demo",
        group: "demo",
        startedAt: null,
        mtimeMs: 1,
        live: false,
        ended: true,
        tokens: null,
        cost: null,
        lastTool: null,
        thinking: null,
      },
    ],
  },
];
const sessionPage = { id: "s1", live: false, ended: true, entries: [], next: 3 };

let setSettingsMessage = "";
let setSettingsError = "";

mock.module("../../wailsjs/go/main/App", () => ({
  State: async () => ({ repos: [], message: null, now: "2026-11-02T00:00:00.000Z" }),
  Session: async () => sessionPage,
  AddRepo: async () => "",
  RemoveRepo: async () => "",
  Settings: async () => {
    settingsCalls.push(1);
    return settingsValue;
  },
  SetSettings: async (value: { ompSessions: boolean; piSessions: boolean; scope: string }) => {
    setSettingsCalls.push(value);
    return setSettingsError;
  },
  Agents: async () => {
    agentsCalls.push(1);
    return agentGroups;
  },
  AgentSession: async (agent: string, group: string, id: string, after: number) => {
    agentSessionCalls.push([agent, group, id, after]);
    return sessionPage;
  },
}));

const { fetchAgentSession, fetchAgents, fetchSettings, saveSettings } = await import("./agents-api");

test("fetchSettings calls the Settings binding and returns its value", async () => {
  settingsCalls.length = 0;
  const value = await fetchSettings();
  expect(settingsCalls).toHaveLength(1);
  expect(value).toBe(settingsValue);
});

test("saveSettings forwards the settings and returns the binding message", async () => {
  setSettingsCalls.length = 0;
  setSettingsError = "";
  const saved = await saveSettings({ ompSessions: true, piSessions: false, scope: "repos" as const });
  expect(setSettingsCalls).toHaveLength(1);
  expect(setSettingsCalls[0]).toEqual({ ompSessions: true, piSessions: false, scope: "repos" as const });
  expect(saved).toBe("");
});

test("saveSettings passes the error message through unchanged", async () => {
  setSettingsCalls.length = 0;
  setSettingsError = "cannot write settings";
  const message = await saveSettings({ ompSessions: false, piSessions: true, scope: "all" as const });
  expect(setSettingsCalls).toHaveLength(1);
  expect(setSettingsCalls[0]).toEqual({ ompSessions: false, piSessions: true, scope: "all" as const });
  expect(message).toBe("cannot write settings");
  setSettingsError = "";
});

test("fetchAgents calls the Agents binding and returns its groups", async () => {
  agentsCalls.length = 0;
  const groups = await fetchAgents();
  expect(agentsCalls).toHaveLength(1);
  expect(groups).toBe(agentGroups);
});

test("fetchAgentSession forwards the agent, group, id and after cursor", async () => {
  agentSessionCalls.length = 0;
  const page = await fetchAgentSession("omp", "demo", "s1", 7);
  expect(agentSessionCalls).toHaveLength(1);
  expect(agentSessionCalls[0]).toEqual(["omp", "demo", "s1", 7]);
  expect(page).toBe(sessionPage);
});
