import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ModelSelection from "@agent/lib/model/selection";
import { skippedSendNotice } from "@agent/lib/delivery/turn-sends";
import { skillRecord } from "@agent/lib/skills/render";
import { defaultFormOfAddress } from "@shared/chat/form-of-address";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import {
  fullDeployment,
  stubDeployment,
  taskAgentDeployment,
} from "@tests/helpers/system-prompt";
import {
  catalogContext,
  type catalogKinds,
  toolCatalog,
  toolsDigest,
} from "@tests/helpers/tool-catalog";

const services = vi.hoisted(() => ({
  modelSelection: vi.fn<typeof ModelSelection.modelSelection>(),
}));

// The tool router's decision model, which only its pilot asks: mail.
vi.mock("@agent/lib/tool-router/system-one", () => ({
  askRouterQuestions: async () => ({
    answers: new Map([["mail", 0.93]]),
    model: "jev-1.14.0",
    ms: 90,
    provider: "typesafe",
  }),
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
async function stepTools(
  kind: Kind,
  steps: readonly (readonly ModelMessage[])[],
  pilot: boolean,
  skills = false,
  router = false,
  deployment: Record<string, string> = fullDeployment
) {
  stubDeployment(
    router
      ? {
          ...deployment,
          SKILLS_WORKSPACES: "*",
          TOOL_ROUTER_MODE: "on",
          TOOL_ROUTER_WORKSPACES: "*",
        }
      : skills
        ? { ...deployment, SKILLS_WORKSPACES: "*" }
        : deployment
  );
  vi.stubEnv("STEP_CONTEXT_WORKSPACES", pilot ? "*" : "");
  const [agent, { stepToolsTransform }] = await Promise.all([
    import("@agent/agent").then((module) => module.default),
    import("@agent/lib/model/direct"),
  ]);
  const blocks: ReturnType<typeof stepToolsTransform>[] = [];
  for (const [stepIndex, messages] of steps.entries()) {
    const event = {
      data: { sequence: 1, stepIndex, turnId: "turn-1" },
      type: "step.started",
    };
    const context = catalogContext(kind, messages);
    // oxlint-disable-next-line eslint/no-await-in-loop -- one step after another
    const catalog = await toolCatalog(context, {
      step: { stepIndex, turnId: "turn-1" },
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- one step after another
    await agent.model.events["step.started"]?.(event, context);
    const options = services.modelSelection.mock.lastCall?.[1];
    if (!options) throw new Error("No model selection was made.");
    blocks.push(
      stepToolsTransform(catalog, {
        forcedReply: options.toolChoice === "required",
        groups: options.toolGroups,
        offered: options.offeredTools,
        routerGroups: options.routerGroups,
        stableContext: options.stableContext,
        withheld: options.withheldTools ?? [],
      })
    );
  }
  vi.stubEnv("STEP_CONTEXT_WORKSPACES", "");
  vi.stubEnv("SKILLS_WORKSPACES", "");
  vi.stubEnv("TOOL_ROUTER_MODE", "");
  vi.stubEnv("TOOL_ROUTER_WORKSPACES", "");
  return blocks;
}

async function toolBlocks(
  kind: Kind,
  steps: readonly (readonly ModelMessage[])[],
  pilot: boolean,
  skills = false,
  deployment: Record<string, string> = fullDeployment
) {
  return (await stepTools(kind, steps, pilot, skills, false, deployment)).map(
    toolsDigest
  );
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

  it(
    "keeps the router's core and groups through a person's turn, and grows only after open_tools",
    { timeout: 60_000 },
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const mail = [person("Ответь Лене на письмо про отпуск")];
      const read = [
        ...mail,
        call("gmail-search", "call-1", { query: "отпуск" }),
        result("gmail-search", "call-1", "[]"),
      ];
      const replied = [
        ...read,
        call("send_message", "call-2", { kind: "message", text: "Нашёл." }),
        result("send_message", "call-2", "submitted"),
      ];
      const opened = [
        ...replied,
        call("open_tools", "call-3", { groups: "media" }),
        {
          content: [
            {
              output: { type: "json" as const, value: { opened: ["media"] } },
              toolCallId: "call-3",
              toolName: "open_tools",
              type: "tool-result" as const,
            },
          ],
          role: "tool" as const,
        },
      ];
      const later = [
        ...opened,
        call("web_search", "call-4", { query: "кот" }),
        result("web_search", "call-4", "кот"),
      ];
      const blocks = await stepTools(
        "web",
        [mail, read, replied, opened, later],
        true,
        true,
        true
      );
      const [first, afterRead, afterReply, afterOpen, afterMore] =
        blocks.map(toolsDigest);
      expect([afterRead, afterReply]).toEqual([first, first]);
      expect(afterOpen).not.toBe(first);
      expect(afterMore).toBe(afterOpen);

      const names = (blocks[0] ?? []).map((tool) => tool.name);
      // The core stays whatever the router chose; the groups it did not
      // choose are left out.
      for (const name of ["privacy", "browser_task", "open_tools"]) {
        expect([name, names.includes(name)]).toEqual([name, true]);
      }
      expect(names).toContain("gmail-send");
      expect(names).not.toContain("slack-search");
      expect(names).not.toContain("generate_image");
      // The core first, then the groups, then the volatile tools.
      expect(names.indexOf("gmail-send")).toBeGreaterThan(
        names.indexOf("privacy")
      );
      expect(names.at(-1)).toBe("ask_question");
      expect((blocks[3] ?? []).map((tool) => tool.name)).toContain(
        "generate_image"
      );
    }
  );
});

describe("the signing tools (SIGN_WORKSPACES)", () => {
  const signing = {
    ...fullDeployment,
    ...taskAgentDeployment,
    AGENT_SANDBOX: "bro-cloudru",
    SIGN_WORKSPACES: "*",
    TASK_FILES_WORKSPACES: "*",
  };

  async function toolNames(kind: Kind, deployment: Record<string, string>) {
    stubDeployment(deployment);
    const catalog = await toolCatalog(catalogContext(kind, opening));
    return catalog.map(({ name }) => name);
  }

  it(
    "come in the person's and a scheduled report's turns, only where Bro's sandbox can run the kit",
    { timeout: 60_000 },
    async () => {
      for (const kind of ["web", "scheduled-report"] as const) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one deployment after another
        expect(await toolNames(kind, signing)).toEqual(
          expect.arrayContaining(["sign_document", "signature"])
        );
      }
      const { AGENT_SANDBOX: _sandbox, ...elsewhere } = signing;
      expect(await toolNames("web", elsewhere)).not.toContain("signature");
    }
  );

  it("stay the same through a person's turn", { timeout: 60_000 }, async () => {
    const blocks = await toolBlocks(
      "web",
      [opening, searched, answered],
      true,
      false,
      signing
    );
    expect(new Set(blocks).size).toBe(1);
  });
});
