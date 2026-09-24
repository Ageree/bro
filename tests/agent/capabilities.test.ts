import type { DynamicResolveContext } from "eve/tools";
import { readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import personalInfoMemory from "@agent/memory/personal_info";
import profileMemory from "@agent/memory/profile";
import workstreamMemory from "@agent/memory/workstreams";
import calendar from "@agent/tools/calendar";
import contacts from "@agent/tools/contacts";
import formOfAddressTools from "@agent/tools/form_of_address";
import gmail from "@agent/tools/gmail";
import messaging from "@agent/tools/messaging";
import proactiveMessageTools from "@agent/tools/proactive_messages";
import schedules from "@agent/tools/schedules";
import vault from "@agent/tools/vault";

const groupedTools = [
  calendar,
  contacts,
  formOfAddressTools,
  gmail,
  messaging,
  proactiveMessageTools,
  schedules,
  vault,
];

describe("authored mode capability matrix", () => {
  it("gives interactive turns the authored coordinator capabilities", async () => {
    expect(await authoredCapabilities("photon-imessage")).toEqual([
      "calendar-check-availability",
      "calendar-create-event",
      "calendar-delete-event",
      "calendar-list-events",
      "calendar-update-event",
      "contacts-search",
      "form_of_address",
      "gmail-attachment",
      "gmail-draft",
      "gmail-read-thread",
      "gmail-search",
      "gmail-send",
      "gmail-update",
      "personal_info__update",
      "proactive_messages",
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

  it("gives Bro's own checks only the read tools that look at new mail and events", async () => {
    expect(
      await authoredCapabilities("scheduled-worker", {
        scheduledRunKind: "proactive",
      })
    ).toEqual(["calendar-list-events", "gmail-read-thread", "gmail-search"]);
  });

  it("leaves Bro's own checks no tool beyond reading new mail and events", async () => {
    vi.stubEnv("BROWSER_USE_API_KEY", "browser-use-test-key");
    const context = dynamicContext("scheduled-worker", {
      scheduledRunKind: "proactive",
    });
    const directory = new URL("../../agent/tools/", import.meta.url);
    const names = await Promise.all(
      readdirSync(directory)
        .filter((file) => file.endsWith(".ts"))
        .map(async (file) => {
          const name = file.replace(/\.ts$/u, "");
          const toolModule: unknown = await import(
            new URL(file, directory).href
          );
          const perTurn = dynamicToolModuleSchema.safeParse(toolModule).data;
          // Messaging resolves per step to see what the turn already sent.
          const perStep = stepToolModuleSchema.safeParse(toolModule).data;
          const resolve =
            perTurn?.default.events["turn.started"] ??
            perStep?.default.events["step.started"];
          // A module without a resolver is a static tool of its own name.
          if (!resolve) return [name];
          const resolved = await resolve({}, context);
          if (!resolved) return [];
          return "execute" in resolved ? [name] : Object.keys(resolved);
        })
    );
    // Only this test's stub is undone; the suite's own environment stays.
    vi.stubEnv("BROWSER_USE_API_KEY", undefined);

    // ask_question and task_cancel are eve-native tools that cannot be gated
    // per mode; neither reaches outside the session. The gateway web_search is
    // provider-managed; with OpenRouter the search is ours and gated (below).
    expect(names.flat().toSorted()).toEqual([
      "ask_question",
      "calendar-list-events",
      "gmail-read-thread",
      "gmail-search",
      "task_cancel",
      "web_search",
    ]);
  });

  it("fetches pages and photos only in conversations and user-set tasks", async () => {
    const pageTools = [
      (await import("@agent/tools/web_fetch")).default,
      (await import("@agent/tools/find_images")).default,
    ];
    const byRole = await Promise.all(
      ["photon-imessage", "scheduled-worker", "scheduled-result"].map(
        async (role) =>
          (
            await Promise.all(
              pageTools.map(async (definition) =>
                Object.keys(
                  (await definition.events["turn.started"]?.(
                    {},
                    dynamicContext(role)
                  )) ?? {}
                )
              )
            )
          ).flat()
      )
    );
    expect(byRole).toEqual([
      ["web_fetch", "find_images"],
      ["web_fetch", "find_images"],
      // A report turn only delivers what a worker read, untrusted mail
      // included, so it has no way to send that anywhere.
      [],
    ]);
  });

  it("withholds the OpenRouter web search from Bro's own checks and reports", async () => {
    vi.resetModules();
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-test");
    const dynamic = dynamicToolModuleSchema.safeParse(
      await import("@agent/tools/web_search")
    );
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    vi.resetModules();
    expect(dynamic.success).toBe(true);
    if (!dynamic.success) return;
    const resolve = dynamic.data.default.events["turn.started"];

    expect(
      await resolve(
        {},
        dynamicContext("scheduled-worker", { scheduledRunKind: "proactive" })
      )
    ).toBeNull();
    expect(await resolve({}, dynamicContext("scheduled-result"))).toBeNull();
    expect(
      Object.keys((await resolve({}, dynamicContext("photon-imessage"))) ?? {})
    ).toEqual(["web_search"]);
  });

  it("adds browser_task only to a deployment configured for Browser Use", async () => {
    const unconfigured = await loadBrowserTask("");
    // Resolved per step, to count the errands the turn already started.
    const resolveUnconfigured = unconfigured.events["step.started"];
    expect(resolveUnconfigured).toBeDefined();
    if (!resolveUnconfigured) return;
    expect(
      await resolveUnconfigured({}, dynamicContext("photon-imessage"))
    ).toBeNull();

    const configured = await loadBrowserTask("browser-use-test-key");
    const resolve = configured.events["step.started"];
    expect(resolve).toBeDefined();
    if (!resolve) return;

    const resolved = await Promise.all(
      ["photon-imessage", "scheduled-worker", "scheduled-result"].map(
        async (role) => resolve({}, dynamicContext(role))
      )
    );
    expect(
      await resolve(
        {},
        dynamicContext("scheduled-worker", { scheduledRunKind: "proactive" })
      )
    ).toBeNull();

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

/** A tool module whose default export resolves its tools per turn. */
const dynamicToolModuleSchema = z.object({
  default: z.object({
    events: z.object({
      "turn.started": z.custom<
        NonNullable<(typeof calendar)["events"]["turn.started"]>
      >((value) => z.function().safeParse(value).success),
    }),
  }),
});

const stepToolModuleSchema = z.object({
  default: z.object({
    events: z.object({
      "step.started": z.custom<
        NonNullable<(typeof messaging)["events"]["step.started"]>
      >((value) => z.function().safeParse(value).success),
    }),
  }),
});

// The Browser Use key comes from the environment, so each expectation loads
// the tool module against the state it is describing.
async function loadBrowserTask(apiKey: string) {
  vi.resetModules();
  vi.stubEnv("BROWSER_USE_API_KEY", apiKey);
  return (await import("@agent/tools/browser_task")).default;
}

async function authoredCapabilities(
  authenticator: string,
  initiatorAttributes?: Record<string, string>
) {
  const context = dynamicContext(authenticator, initiatorAttributes);
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

function dynamicContext(
  authenticator: string,
  initiatorAttributes?: Record<string, string>
) {
  const current = {
    attributes: { workspaceId: "personal:workspace" },
    authenticator,
    principalId: "user-1",
    principalType: "user",
  };
  return {
    model: null,
    channel: { kind: "channel:photon", metadata: {} },
    messages: [],
    session: {
      auth: {
        current,
        initiator: initiatorAttributes
          ? {
              ...current,
              attributes: { ...current.attributes, ...initiatorAttributes },
            }
          : null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}
