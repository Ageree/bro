import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventZoneRewrites } from "@agent/lib/schedules/event-zone";
import {
  fullDeployment,
  stubDeployment,
  systemPrompt,
  turnKinds,
} from "@tests/helpers/system-prompt";

// What the prompt's resolvers read of a workspace: no limit, Moscow, «ты»,
// other chats.
vi.mock("@db/services/spending", () => ({
  listSpendEntries: async () => [],
  readSpendLimit: async () => undefined,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: async () => "Europe/Moscow",
}));
vi.mock("@db/services/settings", () => ({
  getFormOfAddress: async () => ({ kind: "ty" }),
}));
vi.mock("@db/services/chats", () => ({
  hasOtherConversations: async () => true,
}));

const workspaceId = "workspace-1";

const content = new URL(
  "../../../agent/instructions/content/",
  import.meta.url
);

/** Every instruction file, as the repository has it. */
function instructionFiles() {
  return readdirSync(content, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".md"))
    .map((file) => readFileSync(new URL(file, content), "utf8"));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T09:41:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.stubEnv("SCHEDULE_EVENT_ZONE_WORKSPACES", "");
});

// Review of #476: the pilot's schedules-create takes the departure itself,
// while the instructions set a later step at the moment it opens; a model
// reading both would subtract the day twice.
describe("the pilot of event zones", { timeout: 30_000 }, () => {
  it("rewords only lines its sources still have", () => {
    const files = instructionFiles();
    for (const [line, pilotLine] of eventZoneRewrites) {
      expect(files.filter((file) => file.includes(line))).not.toEqual([]);
      expect(pilotLine).not.toContain(line);
    }
  });

  it("tells a person's turn and the schedules skill to set check-in by the departure", async () => {
    stubDeployment({
      ...fullDeployment,
      SCHEDULE_EVENT_ZONE_WORKSPACES: workspaceId,
    });
    const interactive = await systemPrompt(turnKinds.interactive);
    const { skillBody } = await import("@agent/lib/skills/catalog");
    const read = [
      interactive,
      skillBody("schedules", { browser: true, eventZone: true, images: true }),
    ].join("\n");
    for (const [line, pilotLine] of eventZoneRewrites) {
      expect(read).not.toContain(line);
      expect(read).toContain(pilotLine);
    }
  });

  it("leaves the core of the skills pilot as it was", async () => {
    stubDeployment({ ...fullDeployment, SKILLS_WORKSPACES: workspaceId });
    const before = await systemPrompt(turnKinds.interactive);
    stubDeployment({
      ...fullDeployment,
      SCHEDULE_EVENT_ZONE_WORKSPACES: workspaceId,
      SKILLS_WORKSPACES: workspaceId,
    });
    expect(await systemPrompt(turnKinds.interactive)).toBe(before);
  });
});
