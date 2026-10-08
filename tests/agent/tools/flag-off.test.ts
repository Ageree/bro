import type { OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import type { ModelMessage, wrapLanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardToolsBeforeOutcome } from "@agent/lib/delivery/browser-report";
import { actionsHeldForAnswer } from "@agent/lib/delivery/questions";
import { skippedSendNotice } from "@agent/lib/delivery/turn-sends";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { fullDeployment, stubDeployment } from "@tests/helpers/system-prompt";
import {
  catalogContext,
  type catalogKinds,
  sha256,
  toolCatalog,
} from "@tests/helpers/tool-catalog";

type LanguageModelV4 = ReturnType<typeof wrapLanguageModel>;

const openRouter = vi.hoisted(() => ({
  doGenerate: vi.fn<LanguageModelV4["doGenerate"]>(),
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => ({
    chat: (modelId: string, _settings: OpenRouterChatSettings) => ({
      doGenerate: openRouter.doGenerate,
      doStream: vi.fn<LanguageModelV4["doStream"]>(),
      modelId,
      provider: "openrouter.chat",
      specificationVersion: "v4",
      supportedUrls: {},
    }),
  }),
}));

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  openRouter.doGenerate.mockResolvedValue({
    content: [],
    finishReason: { raw: "stop", unified: "stop" },
    usage: {
      inputTokens: {
        cacheRead: undefined,
        cacheWrite: undefined,
        noCache: 1,
        total: 1,
      },
      outputTokens: { reasoning: undefined, text: 1, total: 1 },
    },
    warnings: [],
  });
});

// The deployment's variables are reset by `stubDeployment`; unstubbing all
// of them would also drop the Composio setup of `tests/setup-env.ts`.
afterEach(() => {
  vi.restoreAllMocks();
});

type Kind = keyof typeof catalogKinds;

const kinds = [
  "browser-report",
  "proactive-worker",
  "scheduled-report",
  "scheduled-worker",
  "telegram",
  "web",
] as const satisfies readonly Kind[];

function person(text: string): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

function call(
  toolName: string,
  toolCallId: string,
  input: Readonly<Record<string, string>>
): ModelMessage {
  return {
    content: [{ input, toolCallId, toolName, type: "tool-call" }],
    role: "assistant",
  };
}

function result(
  toolName: string,
  toolCallId: string,
  value: string
): ModelMessage {
  return {
    content: [
      {
        output: { type: "text", value },
        toolCallId,
        toolName,
        type: "tool-result",
      },
    ],
    role: "tool",
  };
}

// A person's turn, step by step.
const opening = [person("Привет! Что у меня завтра?")];
const answered = [
  ...opening,
  call("web_search", "call-1", { query: "погода завтра" }),
  result("web_search", "call-1", "Солнечно"),
  call("send_message", "call-2", { kind: "message", text: "Завтра солнечно." }),
  result("send_message", "call-2", "submitted"),
];
const pastAnswer = [
  ...answered,
  call("send_message", "call-3", { kind: "message", text: "Завтра солнечно." }),
  result("send_message", "call-3", skippedSendNotice("duplicate")),
];
const asked = [
  ...answered,
  call("ask_question", "call-4", { prompt: "Какой город?" }),
  result("ask_question", "call-4", "Москва"),
];
const heldQuestion = [
  ...answered,
  call("send_message", "call-5", {
    kind: "message",
    text: "Напоминание о зарядке стоит на 8:00. Остановить его или оставить?",
  }),
  result("send_message", "call-5", "submitted"),
];
const declinedMail: ModelMessage[] = [
  ...answered,
  {
    content: [
      {
        input: { body: "Привет", subject: "Привет", to: ["a@example.com"] },
        toolCallId: "call-6",
        toolName: "gmail-send",
        type: "tool-call",
      },
      {
        approvalId: "approval-1",
        toolCallId: "call-6",
        type: "tool-approval-request",
      },
    ],
    role: "assistant",
  },
  {
    content: [
      {
        approvalId: "approval-1",
        approved: false,
        type: "tool-approval-response",
      },
    ],
    role: "tool",
  },
];
const taskReport = [
  Object.assign(
    {
      content:
        "Background task task_0998 (task) is completed.\n\nResult:\nГотово.",
      role: "user" as const,
    },
    { kind: "execution.background_task" }
  ),
];

// A browser report's turn, step by step.
const report = [
  Object.assign(
    {
      content: `${backgroundTurnMarker}\nBrowser run run-1 finished.\nResult: booked.`,
      role: "user" as const,
    },
    { kind: "user" }
  ),
];
const reportRead = [
  ...report,
  call("list_orders", "call-1", {}),
  result("list_orders", "call-1", "[]"),
];
const told = [
  ...reportRead,
  call("send_message", "call-2", {
    kind: "message",
    text: "Записал на 3 октября, 14:30.",
  }),
  result("send_message", "call-2", "submitted"),
];
const reportPast = [
  ...told,
  call("send_message", "call-3", {
    kind: "message",
    text: "Записал на 3 октября, 14:30.",
  }),
  result("send_message", "call-3", skippedSendNotice("duplicate")),
];

/**
 * What `agent/agent.ts` asks of a step outside both pilots, by kind, each
 * step with the history it is resolved for: a step-scoped tool (the mail's
 * draft after a declined card, the messaging tools past an answer) is what
 * that history makes it, and a turn-scoped one what the turn's first
 * message made it.
 */
const stepCases: Record<
  Kind,
  readonly {
    readonly messages: readonly ModelMessage[];
    readonly offeredTools?: readonly string[];
    readonly toolChoice: "auto" | "none" | "required";
    readonly turn: readonly ModelMessage[];
    readonly withheldTools: readonly string[];
  }[]
> = {
  "browser-report": [
    // Before its message, after a read, after the message, past its
    // answer, and the step that ends it.
    {
      messages: report,
      toolChoice: "required",
      turn: report,
      withheldTools: ["ask_question", ...cardToolsBeforeOutcome, "task"],
    },
    {
      messages: reportRead,
      toolChoice: "auto",
      turn: report,
      withheldTools: ["ask_question", ...cardToolsBeforeOutcome, "task"],
    },
    {
      messages: told,
      toolChoice: "auto",
      turn: report,
      withheldTools: ["ask_question", "task"],
    },
    {
      messages: reportPast,
      toolChoice: "auto",
      turn: report,
      withheldTools: [
        "ask_question",
        "react_to_message",
        "send_message",
        "task",
      ],
    },
    {
      messages: reportPast,
      toolChoice: "none",
      turn: report,
      withheldTools: ["ask_question", "task"],
    },
  ],
  "proactive-worker": [
    {
      messages: opening,
      toolChoice: "auto",
      turn: opening,
      withheldTools: ["task"],
    },
  ],
  "scheduled-report": [
    {
      messages: opening,
      toolChoice: "auto",
      turn: opening,
      withheldTools: ["ask_question", "task"],
    },
  ],
  "scheduled-worker": [
    {
      messages: opening,
      toolChoice: "auto",
      turn: opening,
      withheldTools: ["task"],
    },
  ],
  telegram: [
    {
      messages: opening,
      toolChoice: "required",
      turn: opening,
      withheldTools: ["task"],
    },
    {
      messages: answered,
      toolChoice: "auto",
      turn: opening,
      withheldTools: ["task"],
    },
    {
      messages: declinedMail,
      toolChoice: "auto",
      turn: opening,
      withheldTools: ["task"],
    },
  ],
  web: [
    // Until the reply, after it, past the answer, after a question, while
    // a question waits for an answer, after a declined mail card, with the
    // task agent, and a turn that delivers the task agent's report.
    {
      messages: opening,
      toolChoice: "required",
      turn: opening,
      withheldTools: ["task"],
    },
    {
      messages: answered,
      toolChoice: "auto",
      turn: opening,
      withheldTools: ["task"],
    },
    {
      messages: pastAnswer,
      toolChoice: "none",
      turn: opening,
      withheldTools: ["task"],
    },
    {
      messages: asked,
      toolChoice: "required",
      turn: opening,
      withheldTools: ["ask_question", "task"],
    },
    {
      messages: heldQuestion,
      toolChoice: "auto",
      turn: opening,
      withheldTools: [...actionsHeldForAnswer, "task"],
    },
    {
      messages: declinedMail,
      toolChoice: "auto",
      turn: opening,
      withheldTools: ["task"],
    },
    {
      messages: opening,
      toolChoice: "required",
      turn: opening,
      withheldTools: [],
    },
    {
      messages: taskReport,
      offeredTools: ["react_to_message", "send_message", "task", "task_cancel"],
      toolChoice: "required",
      turn: taskReport,
      withheldTools: ["task"],
    },
  ],
};

/**
 * Deployments whose tools differ, each with a hash per kind of turn of the
 * tools every step `agent/agent.ts` builds outside the pilots sends, each
 * resolved for its own history, taken on the code before item 25 (1972be7,
 * 3 October 2026). Outside both pilots the bytes a step sends must stay as
 * they were; a change to a tool itself changes these on purpose, and the new
 * hashes come from that same code with this test.
 */
const deployments = {
  bare: {
    environment: {},
    hashes: {
      "browser-report":
        "a63a86f25aaa2b6f0c3442fcb6a0e013d3698e8aaf450256fafdca25fe99c13e",
      "proactive-worker":
        "b09b9cdafbd7f1eb1b80a1d070038207742f0119de28cb9b7bb4455ca582ff9e",
      "scheduled-report":
        "9c1d52f248d1e9f284a43d04c84faf7195c4c5ea04a37cbef91c3159f59ad4a2",
      "scheduled-worker":
        "d0919a9fe12e9d5e76c06b2a4821430a724926cc8b48a94741fabecf0ffa2509",
      telegram:
        "b8b7d2d587378251d62f07a9836bb89f6248d0a87c62b82b1f3654b83fe10aa4",
      web: "f456345c29dc0ed736a2a48a54a3a977120768e502bd0f7e02fe2376949cde96",
    } satisfies Record<Kind, string>,
  },
  full: {
    environment: fullDeployment,
    hashes: {
      "browser-report":
        "be687cad233e6bcb377381a17c10ab19057180704fe5412ff986e36397313430",
      "proactive-worker":
        "44390f9721a3895cd947c51ee393d4a1fda462f7f82528cfe2cf12c11a9436db",
      "scheduled-report":
        "79637a7dbfa6f7712074efe0d1e4e86b66b4b58c886977e00710942d4b213130",
      "scheduled-worker":
        "02c0060cbdf40c0d65de076d7965bc84e61f28f9abdc998e64de3a2777370334",
      telegram:
        "291bbec5bc80d8c51529803f7d57436c49afe714f79c31dc7173b3405b50de92",
      web: "c075c77b80f0c39c8de5b2c90d959a2868b2a8089a74d84d31d814ff2a03b022",
    } satisfies Record<Kind, string>,
  },
};

async function stepBytes(environment: Record<string, string>, kind: Kind) {
  stubDeployment(environment);
  const catalogs = [];
  for (const [stepIndex, { messages, turn }] of stepCases[kind].entries()) {
    catalogs.push(
      // oxlint-disable-next-line eslint/no-await-in-loop -- one step at a time, in order
      await toolCatalog(catalogContext(kind, messages), {
        step: { stepIndex, turnId: "turn-1" },
        turnMessages: turn,
      })
    );
  }
  // The transform needs the direct model, whatever the deployment's tools.
  vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
  vi.resetModules();
  const { directModelSelection } = await import("@agent/lib/model/direct");
  openRouter.doGenerate.mockClear();
  for (const [index, { offeredTools, toolChoice, withheldTools }] of stepCases[
    kind
  ].entries()) {
    const options = { offeredTools, toolChoice, withheldTools };
    // oxlint-disable-next-line eslint/no-await-in-loop -- one step at a time, in order
    await directModelSelection(
      "deepseek/deepseek-v4.1-flash",
      offeredTools === undefined ? { toolChoice, withheldTools } : options
    ).model.doGenerate({ prompt: [], tools: catalogs[index] });
  }
  const steps = openRouter.doGenerate.mock.calls.map(([request]) => [
    request.toolChoice ?? null,
    request.tools ?? [],
  ]);
  return sha256(JSON.stringify({ catalogs, steps }));
}

describe("tools outside both pilots", () => {
  it.each(Object.entries(deployments))(
    "are byte for byte what they were before item 25, in every kind of turn (%s deployment)",
    { timeout: 60_000 },
    async (_name, { environment, hashes }) => {
      const actual = new Map<string, string>();
      for (const kind of kinds) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each kind loads its modules afresh
        actual.set(kind, await stepBytes(environment, kind));
      }
      expect(Object.fromEntries(actual)).toEqual(hashes);
    }
  );

  it("cover every tool of a fully set-up deployment", async () => {
    stubDeployment(fullDeployment);
    const names = (await toolCatalog(catalogContext("web", opening))).map(
      ({ name }) => name
    );
    expect(names.length).toBeGreaterThan(55);
    expect(names).toEqual(
      expect.arrayContaining([
        "ask_question",
        "browser_task",
        "gmail-send",
        "notion-search",
        "profile__forget_all",
        "schedules-create",
        "send_message",
        "workstreams__save",
      ])
    );
  });
});
