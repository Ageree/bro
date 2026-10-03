import type { OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import type { wrapLanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardToolsBeforeOutcome } from "@agent/lib/delivery/browser-report";
import { actionsHeldForAnswer } from "@agent/lib/delivery/questions";
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

/** What `agent/agent.ts` asks of a step outside both pilots, by kind. */
const stepCases: Record<
  Kind,
  readonly {
    readonly offeredTools?: readonly string[];
    readonly toolChoice: "auto" | "none" | "required";
    readonly withheldTools: readonly string[];
  }[]
> = {
  "browser-report": [
    // Before its message, after it, past its answer.
    {
      toolChoice: "required",
      withheldTools: ["ask_question", ...cardToolsBeforeOutcome, "task"],
    },
    {
      toolChoice: "auto",
      withheldTools: ["ask_question", ...cardToolsBeforeOutcome, "task"],
    },
    { toolChoice: "auto", withheldTools: ["ask_question", "task"] },
    {
      toolChoice: "auto",
      withheldTools: [
        "ask_question",
        "react_to_message",
        "send_message",
        "task",
      ],
    },
    { toolChoice: "none", withheldTools: ["ask_question", "task"] },
  ],
  "proactive-worker": [{ toolChoice: "auto", withheldTools: ["task"] }],
  "scheduled-report": [
    { toolChoice: "auto", withheldTools: ["ask_question", "task"] },
  ],
  "scheduled-worker": [{ toolChoice: "auto", withheldTools: ["task"] }],
  telegram: [
    { toolChoice: "required", withheldTools: ["task"] },
    { toolChoice: "auto", withheldTools: ["task"] },
  ],
  web: [
    // Until the reply, after it, past the answer, after a question, while
    // a question waits for an answer, with the task agent, and a turn that
    // delivers the task agent's report.
    { toolChoice: "required", withheldTools: ["task"] },
    { toolChoice: "auto", withheldTools: ["task"] },
    { toolChoice: "none", withheldTools: ["task"] },
    { toolChoice: "required", withheldTools: ["ask_question", "task"] },
    { toolChoice: "auto", withheldTools: [...actionsHeldForAnswer, "task"] },
    { toolChoice: "required", withheldTools: [] },
    {
      offeredTools: ["react_to_message", "send_message", "task", "task_cancel"],
      toolChoice: "required",
      withheldTools: ["task"],
    },
  ],
};

/**
 * Deployments whose tools differ, each with a hash per kind of turn of its
 * catalog and of every step `agent/agent.ts` builds of it outside the
 * pilots, taken before item 25 (3 October 2026). Outside both pilots the
 * bytes a step sends must stay as they were; a change to a tool itself
 * changes these on purpose.
 */
const deployments = {
  bare: {
    environment: {},
    hashes: {
      "browser-report":
        "42fd8f9ce62e26ec3869fce859b101040a33b2cfce14ab5836371307e4fbddcc",
      "proactive-worker":
        "dab8329658162d816c1a616cf8e6d5384702c6e8effff1442ccf65920b755209",
      "scheduled-report":
        "5c29c7c7ec4895fc5f668b631f90c6ce38cf83963a6d4f78f6d90d2b120b37c2",
      "scheduled-worker":
        "5a55168e334ffb79ad5c2734cc296c6ddf8d25d57475c1fca1a7eadc739b8166",
      telegram:
        "c3718f5a11ed558f7be8c942420e4dde5e53f36cf9c8ed496b46709d852d284c",
      web: "149c10c9d06e88091f5ba69fbeb64e369b4ac582426e07012042f90389843bea",
    } satisfies Record<Kind, string>,
  },
  full: {
    environment: fullDeployment,
    hashes: {
      "browser-report":
        "0a9cc15b183d8c1b06b94968d06cb013eddc56bf835889766ed41f3f3d51641b",
      "proactive-worker":
        "4efe5121048d2319aa8c4fbc3ac9689494ae048bc1a380cd774b4df541ad778c",
      "scheduled-report":
        "3b5c145ce74f35a0dd897b0da8c8c9d84caff8c14a7c1fad8ce516b88e82b352",
      "scheduled-worker":
        "e0b7969e4c1e893b6c5c09a8c798ebd02ac822d9702e987ce2f41548da35067c",
      telegram:
        "108b3dd1f94d492fbca39bd6407ca0b45b1f605d0e2ee6bb241d53894a7c1cda",
      web: "1ace613d84210501d22959c7dfea63eececea23d177b6df3394debc66a9fc892",
    } satisfies Record<Kind, string>,
  },
};

const conversation = [
  { content: "Привет! Что у меня завтра?", role: "user" as const },
];

async function stepBytes(environment: Record<string, string>, kind: Kind) {
  stubDeployment(environment);
  const catalog = await toolCatalog(catalogContext(kind, conversation));
  // The transform needs the direct model, whatever the deployment's tools.
  vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
  vi.resetModules();
  const { directModelSelection } = await import("@agent/lib/model/direct");
  openRouter.doGenerate.mockClear();
  for (const options of stepCases[kind]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one step at a time, in order
    await directModelSelection(
      "deepseek/deepseek-v4.1-flash",
      options
    ).model.doGenerate({ prompt: [], tools: catalog });
  }
  const steps = openRouter.doGenerate.mock.calls.map(([call]) => [
    call.toolChoice ?? null,
    call.tools ?? [],
  ]);
  return sha256(JSON.stringify({ catalog, steps }));
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
    const names = (await toolCatalog(catalogContext("web", conversation))).map(
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
