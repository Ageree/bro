import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ModelSelection from "@agent/lib/model/selection";
import { skippedSendNotice } from "@agent/lib/delivery/turn-sends";
import { skillRecord } from "@agent/lib/skills/render";
import { defaultFormOfAddress } from "@shared/chat/form-of-address";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { fullDeployment, stubDeployment } from "@tests/helpers/system-prompt";
import {
  catalogContext,
  type catalogKinds,
  toolCatalog,
  toolsDigest,
} from "@tests/helpers/tool-catalog";

const services = vi.hoisted(() => ({
  modelSelection: vi.fn<typeof ModelSelection.modelSelection>(),
}));

vi.mock("@db/services/browser-runs", () => ({
  browserRunReportDelivered: async () => false,
}));
vi.mock("@db/services/scheduled-agent-run-leases", () => ({
  isScheduledAgentRunLeaseActive: async () => true,
}));
vi.mock("@db/services/settings", () => ({
  getFormOfAddress: async () => defaultFormOfAddress,
  getWorkspaceModelId: async () => "deepseek/deepseek-v4.1-flash",
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: async () => "Europe/Moscow",
}));
vi.mock("@agent/lib/model/selection", () => ({
  modelSelection: services.modelSelection,
}));

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  services.modelSelection.mockReturnValue("deepseek/deepseek-v4.1-flash");
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Kind = keyof typeof catalogKinds;

/**
 * The tool block of each step of one turn, as the step sends it: the tools
 * every resolver gives for the step's messages, through the model
 * selection `agent/agent.ts` makes of the same messages.
 */
async function toolBlocks(
  kind: Kind,
  steps: readonly (readonly ModelMessage[])[],
  pilot: boolean,
  skills = false
) {
  stubDeployment(
    skills ? { ...fullDeployment, SKILLS_WORKSPACES: "*" } : fullDeployment
  );
  vi.stubEnv("STEP_CONTEXT_WORKSPACES", pilot ? "*" : "");
  const [agent, { stepToolsTransform }] = await Promise.all([
    import("@agent/agent").then((module) => module.default),
    import("@agent/lib/model/direct"),
  ]);
  const blocks: string[] = [];
  for (const [stepIndex, messages] of steps.entries()) {
    const event = {
      data: { sequence: 1, stepIndex, turnId: "turn-1" },
      type: "step.started",
    };
    const context = catalogContext(kind, messages);
    // oxlint-disable-next-line eslint/no-await-in-loop -- one step after another
    const catalog = await toolCatalog(context, event);
    // oxlint-disable-next-line eslint/no-await-in-loop -- one step after another
    await agent.model.events["step.started"]?.(event, context);
    const options = services.modelSelection.mock.lastCall?.[1];
    if (!options) throw new Error("No model selection was made.");
    blocks.push(
      toolsDigest(
        stepToolsTransform(catalog, {
          forcedReply: options.toolChoice === "required",
          groups: options.toolGroups,
          offered: options.offeredTools,
          stableContext: options.stableContext,
          withheld: options.withheldTools ?? [],
        })
      )
    );
  }
  vi.stubEnv("STEP_CONTEXT_WORKSPACES", "");
  vi.stubEnv("SKILLS_WORKSPACES", "");
  return blocks;
}

function person(text: string) {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    {
      kind: "user",
    }
  );
}

function call(
  toolName: string,
  toolCallId: string,
  input: Readonly<Record<string, string>>
) {
  return {
    content: [{ input, toolCallId, toolName, type: "tool-call" as const }],
    role: "assistant" as const,
  };
}

function result(toolName: string, toolCallId: string, value: string) {
  return {
    content: [
      {
        output: { type: "text" as const, value },
        toolCallId,
        toolName,
        type: "tool-result" as const,
      },
    ],
    role: "tool" as const,
  };
}

const opening = [person("Привет! Что у меня завтра?")];
const searched = [
  ...opening,
  call("web_search", "call-1", { query: "погода завтра" }),
  result("web_search", "call-1", "Солнечно"),
];
const answered = [
  ...searched,
  call("send_message", "call-2", { kind: "message", text: "Завтра солнечно." }),
  result("send_message", "call-2", "submitted"),
];
const declinedMail = [
  ...answered,
  {
    content: [
      {
        input: { body: "Привет", subject: "Привет", to: ["a@example.com"] },
        toolCallId: "call-3",
        toolName: "gmail-send",
        type: "tool-call" as const,
      },
      {
        approvalId: "approval-1",
        toolCallId: "call-3",
        type: "tool-approval-request" as const,
      },
    ],
    role: "assistant" as const,
  },
  {
    content: [
      {
        approvalId: "approval-1",
        approved: false,
        type: "tool-approval-response" as const,
      },
    ],
    role: "tool" as const,
  },
];
const heldQuestion = [
  ...declinedMail,
  call("send_message", "call-4", {
    kind: "message",
    text: "Напоминание о зарядке стоит на 8:00. Остановить его или оставить?",
  }),
  result("send_message", "call-4", "submitted"),
];
const askedQuestion = [
  ...answered,
  call("ask_question", "call-5", { prompt: "Какой город?" }),
];

/** A record of the `skills` slot, as eve keeps it in history. */
function slotRecord(name: Parameters<typeof skillRecord>[0]) {
  return Object.assign(
    {
      content: skillRecord(name, { browser: true, images: true }) ?? "",
      role: "user" as const,
    },
    { kind: "memory.load" }
  );
}

// The skills slot attached google's block to the opening turn.
const skillOpening = [...opening, slotRecord("google")];
const skillSearched = [
  ...skillOpening,
  call("calendar-list-events", "call-1", {}),
  result("calendar-list-events", "call-1", "[]"),
];
const skillAnswered = [
  ...skillSearched,
  call("send_message", "call-2", { kind: "message", text: "Завтра свободно." }),
  result("send_message", "call-2", "submitted"),
];
const loadedApps = [
  ...skillAnswered,
  call("load_skill", "call-3", { name: "apps" }),
  result(
    "load_skill",
    "call-3",
    skillRecord("apps", { browser: true, images: true }) ?? ""
  ),
];
const nextTurn = [...loadedApps, person("Спасибо!")];

const report = [
  Object.assign(
    {
      content: `${backgroundTurnMarker}\nBrowser run run-1 finished.\nResult: booked.`,
      role: "user" as const,
    },
    { kind: "user" }
  ),
];
const told = [
  ...report,
  call("send_message", "call-1", {
    kind: "message",
    text: "Записал на 3 октября, 14:30.",
  }),
  result("send_message", "call-1", "submitted"),
];
const pastAnswer = [
  ...told,
  call("send_message", "call-2", { kind: "message", text: "Готово." }),
  result("send_message", "call-2", skippedSendNotice("duplicate")),
];

describe("the tool block of a turn in the pilot of the cache-friendly step", () => {
  it(
    "stays the same through a person's turn, but after a question",
    { timeout: 60_000 },
    async () => {
      const [first, ...rest] = await toolBlocks(
        "web",
        [
          opening,
          searched,
          answered,
          declinedMail,
          heldQuestion,
          askedQuestion,
        ],
        true
      );
      const [afterSearch, afterAnswer, afterCard, held, asked] = rest;
      // The forced first step, a read, the reply and a declined card leave
      // the block as it was: `send_message`'s schema and `gmail-draft`'s
      // description do not change.
      expect([afterSearch, afterAnswer, afterCard]).toEqual([
        first,
        first,
        first,
      ]);
      // The allowed points: the actions a question holds, and
      // `ask_question` after the turn asked one.
      expect(held).not.toBe(first);
      expect(asked).not.toBe(first);
    }
  );

  it(
    "changed at the reply, the declined card and a report's message before the pilot",
    { timeout: 60_000 },
    async () => {
      const [first, afterSearch, afterAnswer, afterCard] = await toolBlocks(
        "web",
        [opening, searched, answered, declinedMail],
        false
      );
      expect(afterSearch).toBe(first);
      expect(afterAnswer).not.toBe(first);
      expect(afterCard).not.toBe(afterAnswer);

      const [before, after, past] = await toolBlocks(
        "browser-report",
        [report, told, pastAnswer],
        false
      );
      expect(after).not.toBe(before);
      expect(past).not.toBe(after);
    }
  );

  it(
    "follows the skills of the conversation in both pilots, and changes only at a load",
    { timeout: 60_000 },
    async () => {
      const [first, afterRead, afterAnswer, loaded, next] = await toolBlocks(
        "web",
        [skillOpening, skillSearched, skillAnswered, loadedApps, nextTurn],
        true,
        true
      );
      expect([afterRead, afterAnswer]).toEqual([first, first]);
      // `load_skill apps` brings the apps' tools from the next step, and
      // the next turn keeps them.
      expect(loaded).not.toBe(first);
      expect(next).toBe(loaded);
    }
  );

  it(
    "stays the same through a browser report's turn, from its first step to past its answer",
    { timeout: 60_000 },
    async () => {
      const blocks = await toolBlocks(
        "browser-report",
        [report, told, pastAnswer],
        true
      );
      expect(new Set(blocks).size).toBe(1);
    }
  );
});
