import { readdirSync, readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessScope } from "@shared/identity/access-scope";
import type { ScheduleDelegation } from "@shared/schedules/delegation";
import { delegationRewrites } from "@agent/lib/schedules/delegation/text";
import {
  fullDeployment,
  stubDeployment,
  systemPrompt,
  turnKinds,
} from "@tests/helpers/system-prompt";
import { toolContext } from "@tests/helpers/tool-context";

const jobs = vi.hoisted(() => ({
  getScheduledAgentJob:
    vi.fn<
      (
        scope: AccessScope,
        id: string
      ) => Promise<
        { readonly delegation: ScheduleDelegation | null } | undefined
      >
    >(),
}));

vi.mock("@db/services/scheduled-agent-jobs", () => jobs);
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
const scheduleId = "00000000-0000-4000-8000-0000000000aa";

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

/** Tokens as `scripts/costs/step-context.ts` estimates instructions. */
const tokens = (text: string) => text.length / 3.1;

const accountant: ScheduleDelegation = {
  about: "показания счётчиков за месяц",
  kind: "email",
  to: ["buh@example.com"],
};

/** A scheduled task's run, whose schedule is `scheduleId`. */
function scheduledRun() {
  const base = toolContext("gmail-send");
  return {
    ...base,
    session: {
      ...base.session,
      auth: {
        current: {
          attributes: { scheduleId, workspaceId },
          authenticator: "scheduled-worker",
          issuer: "open-instinct",
          principalId: "user-1",
          principalType: "user" as const,
        },
        initiator: null,
      },
    },
  } satisfies ToolContext;
}

async function loadRun(pilot: string) {
  vi.resetModules();
  vi.stubEnv("BACKGROUND_ACTIONS_WORKSPACES", pilot);
  return import("@agent/lib/schedules/delegation/run");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T09:41:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.stubEnv("BACKGROUND_ACTIONS_WORKSPACES", "");
  vi.clearAllMocks();
});

describe("the pilot of schedules that act", { timeout: 30_000 }, () => {
  it("rewords only lines its sources still have", () => {
    const files = instructionFiles();
    for (const [line, pilotLine] of delegationRewrites) {
      expect(files.filter((file) => file.includes(line))).not.toEqual([]);
      expect(pilotLine).not.toBe(line);
    }
  });

  it("tells a person's turn and the scheduled run what a run may do", async () => {
    stubDeployment({
      ...fullDeployment,
      BACKGROUND_ACTIONS_WORKSPACES: workspaceId,
    });
    const interactive = await systemPrompt(turnKinds.interactive);
    const worker = await systemPrompt(turnKinds["scheduled-worker"]);
    // A line only a skill's body has reaches the turn with the skill.
    const { skillBody, skillNames } = await import("@agent/lib/skills/catalog");
    const bodies = skillNames.map((name) =>
      skillBody(name, {
        backgroundActions: true,
        browser: true,
        images: true,
      })
    );
    const read = [interactive, worker, ...bodies].join("\n");
    for (const [line, pilotLine] of delegationRewrites) {
      expect(read).not.toContain(line);
      expect(read).toContain(pilotLine);
    }
    // A proactive check never acts on a delegation.
    expect(await systemPrompt(turnKinds["proactive-worker"])).not.toContain(
      "поручённым"
    );
  });

  it("keeps the core within 10k tokens and the skills' bodies reworded", async () => {
    stubDeployment({
      ...fullDeployment,
      BACKGROUND_ACTIONS_WORKSPACES: workspaceId,
      SKILLS_WORKSPACES: workspaceId,
    });
    const core = await systemPrompt(turnKinds.interactive);
    expect(tokens(core)).toBeLessThanOrEqual(10_000);
    expect(core).toContain(
      "От имени человека расписание делает только бесплатное"
    );
    const { skillBody } = await import("@agent/lib/skills/catalog");
    const setup = {
      backgroundActions: true,
      browser: true,
      images: true,
    };
    expect(skillBody("schedules", setup)).toContain(
      "На «запиши меня к Артуру, как только появится слот» поставь проверку с `delegate`"
    );
    expect(
      skillBody("schedules", { ...setup, backgroundActions: false })
    ).toContain("На «записывай, как только появится слот» поставь проверку");
  });

  it("sends only the letter the schedule keeps, to its addresses", async () => {
    jobs.getScheduledAgentJob.mockResolvedValue({ delegation: accountant });
    const { delegatedSendApproval } = await loadRun(workspaceId);

    expect(
      await delegatedSendApproval(scheduledRun(), ["BUH@example.com"])
    ).toBe("not-applicable");
    expect(jobs.getScheduledAgentJob).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId },
      scheduleId
    );
    expect(
      JSON.stringify(
        await delegatedSendApproval(scheduledRun(), [
          "buh@example.com",
          "boss@example.com",
        ])
      )
    ).toContain("boss@example.com is not an address the person named");
  });

  it("sends nothing for a schedule that keeps no letter, or outside the pilot", async () => {
    jobs.getScheduledAgentJob.mockResolvedValue({ delegation: null });
    const inPilot = await loadRun(workspaceId);
    expect(
      JSON.stringify(
        await inPilot.delegatedSendApproval(scheduledRun(), ["buh@example.com"])
      )
    ).toContain("keeps no email");

    jobs.getScheduledAgentJob.mockResolvedValue({ delegation: accountant });
    const outside = await loadRun("");
    expect(
      JSON.stringify(
        await outside.delegatedSendApproval(scheduledRun(), ["buh@example.com"])
      )
    ).toContain("keeps no email");
    expect(jobs.getScheduledAgentJob).toHaveBeenCalledTimes(1);
  });

  it("names the delegation in the run's task only in the pilot", async () => {
    const job = { delegation: accountant, workspaceId };
    expect((await loadRun(workspaceId)).delegationTaskLine(job)).toContain(
      "send one email to buh@example.com"
    );
    expect((await loadRun("")).delegationTaskLine(job)).toBeUndefined();
    expect(
      (await loadRun(workspaceId)).delegationTaskLine({
        delegation: null,
        workspaceId,
      })
    ).toBeUndefined();
  });

  it("refuses an owner's email, which would need a lookup", async () => {
    vi.resetModules();
    vi.stubEnv("BACKGROUND_ACTIONS_WORKSPACES", "alice@example.com");
    await expect(
      import("@agent/lib/schedules/delegation/pilot")
    ).rejects.toThrow("Invalid environment variables");
  });
});
