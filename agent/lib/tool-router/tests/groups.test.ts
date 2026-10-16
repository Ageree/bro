import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentMailClient from "@agent/lib/agent-mail/client";
import { skillNames } from "@agent/lib/skills/catalog";
import {
  routerCoreTool,
  routerGroupsOfTool,
  routerToolNames,
  routerToolOffered,
  skillRouterGroups,
} from "@agent/lib/tool-router/groups";
import {
  routerGroupIndex,
  routerGroups,
  routerQuestions,
  routerThresholds,
} from "@agent/lib/tool-router/questions";
import {
  fullDeployment,
  stubDeployment,
  taskAgentDeployment,
} from "@tests/helpers/system-prompt";
import { catalogContext, toolCatalog } from "@tests/helpers/tool-catalog";

// Bro's own mailbox is read from the database; here every workspace has one.
vi.mock("@agent/lib/agent-mail/client", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentMailClient>()),
  ensureAgentMailbox: async () => ({
    createdAt: new Date(),
    displayName: "Bro",
    email: "quiet.fox42@agentmail.to",
    inboxId: "inbox-1",
    workspaceId: "workspace-1",
  }),
}));

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every pilot that brings tools, on for every workspace. */
const everyPilot = {
  ...fullDeployment,
  ...taskAgentDeployment,
  AGENT_SANDBOX: "bro-cloudru",
  AGENTMAIL_API_KEY: "agentmail-test-key",
  CONTACTS_WORKSPACES: "*",
  ELEVENLABS_API_KEY: "elevenlabs-test-key",
  EVE_SCHEDULES: "on",
  LOCATION_WORKSPACES: "*",
  MAIL_WORKSPACES: "*",
  MTS_EXOLVE_API_KEY: "exolve-test-key",
  PHONE_AGENT_ID: "agent-test",
  PHONE_INIT_SECRET: "i".repeat(32),
  PHONE_WEBHOOK_SECRET: "w".repeat(32),
  PHONE_WORKSPACES: "*",
  SIGN_WORKSPACES: "*",
  SKILLS_WORKSPACES: "*",
  STEP_CONTEXT_WORKSPACES: "*",
  SUBSCRIPTIONS_WORKSPACES: "*",
  TASK_FILES_WORKSPACES: "*",
  TIMEPAD_API_KEY: "timepad-test-key",
  TOOL_ROUTER_MODE: "on",
  TOOL_ROUTER_WORKSPACES: "*",
  VIDEO_WORKSPACES: "*",
  YANDEX_MAIL_CLIENT_ID: "yandex-mail-test-id",
  YANDEX_MAIL_CLIENT_SECRET: "yandex-mail-test-secret",
};

describe("the tool router's groups", () => {
  it("each have tools, a question, a threshold for every model and a line of the index", () => {
    const grouped = new Set(routerToolNames.flatMap(routerGroupsOfTool));
    for (const group of routerGroups) {
      expect([group, grouped.has(group)]).toEqual([group, true]);
      expect(routerQuestions[group].type).toBe("noul");
      expect(routerGroupIndex[group].length).toBeGreaterThan(0);
      for (const thresholds of Object.values(routerThresholds)) {
        expect(thresholds[group]).toBeGreaterThan(0);
      }
    }
    expect(Object.keys(routerQuestions).toSorted()).toEqual(
      [...routerGroups].toSorted()
    );
  });

  it("stand for every skill", () => {
    expect(Object.keys(skillRouterGroups).toSorted()).toEqual(
      [...skillNames].toSorted()
    );
  });

  it("keep privacy, the errands, the calendar's read and the stop tools in the core", () => {
    for (const name of [
      "privacy",
      "browser_task",
      "calendar-list-events",
      "open_tools",
      "proactive_messages",
      "agency_control",
      "profile__remove_memory",
      "profile__forget_all",
      "workstreams__forget",
      "workstreams__forget_all",
      "schedules-update",
      "phone-disable",
      "contact-delete",
    ]) {
      expect([name, routerCoreTool(name)]).toEqual([name, true]);
      expect(routerToolOffered(name, [])).toBe(true);
    }
    // A tool the table does not know fails open.
    expect(routerToolOffered("brand-new-tool", [])).toBe(true);
    // A tool of two groups is there with either.
    expect(routerGroupsOfTool("connect_google")).toEqual(["calendar", "mail"]);
    expect(routerToolOffered("connect_google", ["calendar"])).toBe(true);
    expect(routerToolOffered("phone-call", ["mail"])).toBe(false);
  });

  it(
    "know every tool of a deployment with every pilot",
    { timeout: 60_000 },
    async () => {
      stubDeployment(everyPilot);
      const names = new Set(
        (
          await toolCatalog(
            catalogContext("web", [
              Object.assign(
                { content: "Позвони маме", role: "user" as const },
                { kind: "user" }
              ),
            ])
          )
        ).map((tool) => tool.name)
      );
      for (const name of Object.keys(everyPilot)) vi.stubEnv(name, "");
      expect(names.size).toBeGreaterThan(70);
      for (const name of [
        "open_tools",
        "phone-call",
        "contact-find",
        "mail-search",
        "agent-mail-send",
        "timepad_events",
        "watch-create",
        "location_now",
        "location_history",
        "location_edit",
        "place_reminder",
        "sign_document",
      ]) {
        expect([name, names.has(name)]).toEqual([name, true]);
      }
      expect(
        [...names].filter((name) => !routerToolNames.includes(name))
      ).toEqual([]);
      // The location pilot's tools, once they are here, are in `places`.
      for (const name of [...names].filter((tool) =>
        /^location_|^place_reminder$/u.test(tool)
      )) {
        expect(routerGroupsOfTool(name)).toEqual(["places"]);
      }
    }
  );
});

describe("a skill's router groups", () => {
  it("offer every tool its body names", async () => {
    const { availableSkills, skillBody } =
      await import("@agent/lib/skills/catalog");
    const setup = {
      autonomy: true,
      browser: true,
      images: true,
      sign: true,
      taskFiles: true,
    };
    const unreachable = availableSkills(setup).flatMap((skill) => {
      const body = skillBody(skill, setup) ?? "";
      // A tool of another skill's groups is named with the way to it.
      const loads = skillNames.filter((other) =>
        body.includes(`load_skill ${other}`)
      );
      return routerToolNames.flatMap((name) =>
        // `task` is also a parameter of `browser_task` and `phone-call`.
        name !== "task" &&
        body.includes(`\`${name}\``) &&
        ![skill, ...loads].some((own) =>
          routerToolOffered(name, skillRouterGroups[own])
        )
          ? [[skill, name]]
          : []
      );
    });
    expect(unreachable).toEqual([]);
  });
});
