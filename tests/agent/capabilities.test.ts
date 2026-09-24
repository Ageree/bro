import type { DynamicResolveContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";
import personalInfoMemory from "@agent/memory/personal_info";
import profileMemory from "@agent/memory/profile";
import workstreamMemory from "@agent/memory/workstreams";
import calendar from "@agent/tools/calendar";
import contacts from "@agent/tools/contacts";
import gmail from "@agent/tools/gmail";
import messaging from "@agent/tools/messaging";
import schedules from "@agent/tools/schedules";
import vault from "@agent/tools/vault";

const groupedTools = [calendar, contacts, gmail, messaging, schedules, vault];

describe("authored mode capability matrix", () => {
  it("gives interactive turns the authored coordinator capabilities", async () => {
    expect(await authoredCapabilities("photon-imessage")).toEqual([
      "calendar-check-availability",
      "calendar-create-event",
      "calendar-list-events",
      "contacts-search",
      "gmail-attachment",
      "gmail-draft",
      "gmail-read-thread",
      "gmail-search",
      "gmail-send",
      "gmail-update",
      "personal_info__update",
      "profile__find",
      "profile__read",
      "profile__remove_memory",
      "profile__save_memory",
      "profile__semantic_find",
      "profile__update",
      "react_to_message",
      "request_vault_import",
      "request_vault_setup",
      "schedules-answer",
      "schedules-create",
      "schedules-list",
      "schedules-update",
      "send_message",
      "workstreams__find",
      "workstreams__forget",
      "workstreams__read",
      "workstreams__save",
    ]);
  });

  it("gives scheduled workers only authored read and execution capabilities", async () => {
    expect(await authoredCapabilities("scheduled-worker")).toEqual([
      "calendar-check-availability",
      "calendar-list-events",
      "contacts-search",
      "gmail-attachment",
      "gmail-draft",
      "gmail-read-thread",
      "gmail-search",
    ]);
  });

  it("adds browser_task only to a deployment configured for Browser Use", async () => {
    const unconfigured = await loadBrowserTask("");
    const resolveUnconfigured = unconfigured.events["turn.started"];
    expect(resolveUnconfigured).toBeDefined();
    if (!resolveUnconfigured) return;
    expect(
      await resolveUnconfigured({}, dynamicContext("photon-imessage"))
    ).toBeNull();

    const configured = await loadBrowserTask("browser-use-test-key");
    const resolve = configured.events["turn.started"];
    expect(resolve).toBeDefined();
    if (!resolve) return;

    const resolved = await Promise.all(
      ["photon-imessage", "scheduled-worker", "scheduled-result"].map(
        async (role) => resolve({}, dynamicContext(role))
      )
    );

    for (const tools of resolved.slice(0, 2)) {
      expect(tools && !("execute" in tools) ? Object.keys(tools) : []).toEqual([
        "browser_task",
      ]);
    }
    expect(resolved[2]).toBeNull();
  });

  it("limits authored scheduled reporting tools to delivery or resuming its own run", async () => {
    expect(await authoredCapabilities("scheduled-result")).toEqual([
      "request_vault_setup",
      "schedules-answer",
      "send_message",
    ]);
  });
});

// The Browser Use key comes from the environment, so each expectation loads
// the tool module against the state it is describing.
async function loadBrowserTask(apiKey: string) {
  vi.resetModules();
  vi.stubEnv("BROWSER_USE_API_KEY", apiKey);
  return (await import("@agent/tools/browser_task")).default;
}

async function authoredCapabilities(authenticator: string) {
  const context = dynamicContext(authenticator);
  const capabilities: string[] = [];

  const resolvedGroups = await Promise.all(
    groupedTools.map(async (definition) => {
      // Messaging resolves per step to see what the turn already sent.
      const resolve =
        "step.started" in definition.events
          ? definition.events["step.started"]
          : definition.events["turn.started"];
      const resolved = resolve ? await resolve({}, context) : null;
      return resolved && !("execute" in resolved) ? Object.keys(resolved) : [];
    })
  );
  capabilities.push(...resolvedGroups.flat());

  const personalInfoTools = await personalInfoMemory.provider.tools({
    ...context,
    memory: {
      scope: {
        key: "personal-info-key",
        namespace: "openinstinct-personal-info-v1",
        value: "personal:workspace",
      },
      slot: "personal_info",
    },
    turn: { id: "turn-1", input: [], sequence: 1 },
  });
  if (personalInfoTools) {
    capabilities.push(
      ...Object.keys(personalInfoTools).map((name) => `personal_info__${name}`)
    );
  }

  const workstreamTools = await workstreamMemory.provider.tools({
    ...context,
    memory: {
      scope: {
        key: "workstreams-key",
        namespace: "workstreams",
        value: "personal:workspace",
      },
      slot: "workstreams",
    },
    turn: { id: "turn-1", input: [], sequence: 1 },
  });
  if (workstreamTools)
    capabilities.push(
      ...Object.keys(workstreamTools).map((name) => `workstreams__${name}`)
    );

  const profileTools = await profileMemory.provider.tools({
    ...context,
    memory: {
      scope: {
        key: "profile-key",
        namespace: "profile-namespace",
        value: "personal:workspace",
      },
      slot: "profile",
    },
    turn: { id: "turn-1", input: [], sequence: 1 },
  });
  if (profileTools)
    capabilities.push(
      ...Object.keys(profileTools).map((name) => `profile__${name}`)
    );

  return capabilities.toSorted();
}

function dynamicContext(authenticator: string) {
  return {
    model: null,
    channel: { kind: "channel:photon", metadata: {} },
    messages: [],
    session: {
      auth: {
        current: {
          attributes: { workspaceId: "personal:workspace" },
          authenticator,
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}
