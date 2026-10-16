import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  askRouterQuestions,
  RouterAnswer,
} from "@agent/lib/tool-router/system-one";

/** eve's durable state, as one session's in-memory store. */
const stores = vi.hoisted(() => new Map<string, unknown>());

vi.mock("eve/context", () => ({
  defineState: <T>(name: string, initial: () => T) => {
    // SAFETY: each name holds only what its own `update` stored, a `T`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one store serves every state's type.
    const read = () => (stores.has(name) ? (stores.get(name) as T) : initial());
    return {
      get: read,
      update: (next: (value: T) => T) => {
        stores.set(name, next(read()));
      },
    };
  },
}));

const pilot = vi.hoisted(() => ({
  taskKitRouted: vi.fn<() => boolean>(() => true),
}));
vi.mock("@agent/lib/sandbox/pilot", () => pilot);

const jev = vi.hoisted(() => ({
  askRouterQuestions: vi.fn<typeof askRouterQuestions>(),
}));
vi.mock("@agent/lib/tool-router/system-one", () => jev);

import { kitBlocks, kitQuestions } from "@agent/lib/kit-router/questions";
import { hearKitJob, kitBlocksOfSession } from "@agent/lib/kit-router/route";

const job =
  "Сделай презентацию на 10 слайдов по отчёту /workspace/attachments/a/otchet.docx, с графиками.";

/** A message of Bro's to the task agent, as eve wraps it. */
function fromBro(text: string): ModelMessage {
  return {
    content: `You are the subagent "task".\n\nThe caller delegated the following task to you.\n\nCaller message:\n${text}`,
    role: "user",
  };
}

const reply: ModelMessage = {
  content: "Готово: презентация на 10 слайдов.",
  role: "assistant",
};

/** The `turn.started` context of a task agent turn with these messages. */
function turnOf(messages: readonly ModelMessage[]) {
  return {
    messages,
    session: {
      auth: {
        current: {
          attributes: { workspaceId: "personal:workspace" },
          authenticator: "telegram-webhook",
          principalId: "user-1",
          principalType: "user" as const,
        },
        initiator: null,
      },
    },
  };
}

/**
 * Jev's answer through RouterAI with these probabilities, and 0.01 for
 * every other block.
 */
function answer(
  probabilities: Readonly<Record<string, number>>,
  model = "typesafe/jev-1.13-20260917"
): RouterAnswer {
  return {
    answers: new Map([
      ...kitBlocks.map((block) => [block, 0.01] as const),
      ...Object.entries(probabilities),
    ]),
    model,
    ms: 870,
    provider: "routerai",
  };
}

beforeEach(() => {
  stores.clear();
  pilot.taskKitRouted.mockReturnValue(true);
  jev.askRouterQuestions.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the kit router", () => {
  it("gives the session the blocks Jev does not rule out about Bro's job alone, and logs no text of it", async () => {
    jev.askRouterQuestions.mockResolvedValue(
      answer({ data: 0.19, forms: 0.05, money: 0.25, office: 0.97, scans: 0.1 })
    );

    await hearKitJob(turnOf([fromBro(job)]));

    expect(kitBlocksOfSession()).toEqual(["money", "office"]);
    expect(jev.askRouterQuestions).toHaveBeenCalledWith(
      job,
      expect.any(Number),
      kitQuestions
    );
    expect(console.info).toHaveBeenCalledWith(
      "[kit-router] blocks",
      expect.objectContaining({ blocks: ["money", "office"], ms: 870 })
    );
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
      "otchet"
    );
  });

  it("gives every block when Jev fails on the job, answers from a model without thresholds or leaves a block unanswered", async () => {
    for (const failed of [
      { failure: "timeout", ms: 3000 } as const,
      { failure: "no-provider", ms: 0 } as const,
      answer({ office: 0.99 }, "typesafe/jev-2.0"),
      {
        answers: new Map([["office", 0.99]]),
        model: "typesafe/jev-1.13-20260917",
        ms: 870,
        provider: "routerai",
      } as const,
    ]) {
      stores.clear();
      jev.askRouterQuestions.mockResolvedValueOnce(failed);

      // oxlint-disable-next-line eslint/no-await-in-loop -- Each answer opens a session of its own.
      await hearKitJob(turnOf([fromBro(job)]));

      expect(kitBlocksOfSession()).toEqual(kitBlocks);
    }
  });

  it("keeps the set across turns and adds only what a later message clearly needs", async () => {
    jev.askRouterQuestions.mockResolvedValueOnce(answer({ office: 0.97 }));
    await hearKitJob(turnOf([fromBro(job)]));
    const later = fromBro(
      "Ещё сделай QR для оплаты по реквизитам из карточки."
    );

    jev.askRouterQuestions.mockResolvedValueOnce(
      answer({ data: 0.5, money: 0.97, office: 0.1 })
    );
    await hearKitJob(turnOf([fromBro(job), reply, later]));
    expect(kitBlocksOfSession()).toEqual(["money", "office"]);

    jev.askRouterQuestions.mockResolvedValueOnce({
      failure: "timeout",
      ms: 3000,
    });
    await hearKitJob(
      turnOf([fromBro(job), reply, later, reply, fromBro("Пришли ссылку.")])
    );
    expect(kitBlocksOfSession()).toEqual(["money", "office"]);
    expect(jev.askRouterQuestions).toHaveBeenLastCalledWith(
      "Пришли ссылку.",
      expect.any(Number),
      kitQuestions
    );
  });

  it("adds the blocks a job plainly names when Jev rules them out", async () => {
    // Live 16.10: a travel expense report of receipt photos got `money` 0.06 and `scans` 0.04.
    jev.askRouterQuestions.mockResolvedValue(answer({ office: 0.98 }));

    await hearKitJob(
      turnOf([
        fromBro(
          "Сделай авансовый отчёт по командировке и собери все чеки в один PDF.\n/workspace/attachments/a/chek_1.jpg — кассовый чек такси."
        ),
      ])
    );

    expect(kitBlocksOfSession()).toEqual(["money", "office", "scans"]);
  });

  it("gives a loan schedule the rules of money whatever Jev says", async () => {
    // Live 17.10: a mortgage schedule with prepayments got `money` 0.08.
    jev.askRouterQuestions.mockResolvedValue(answer({ office: 0.99 }));

    await hearKitJob(
      turnOf([
        fromBro(
          "Посчитай график по ипотеке в экселе с формулами и двумя досрочками."
        ),
      ])
    );

    expect(kitBlocksOfSession()).toEqual(["money", "office"]);
  });

  it("sends Jev no number of the job: a passport, a СНИЛС or a phone", async () => {
    jev.askRouterQuestions.mockResolvedValue(answer({ forms: 0.99 }));

    await hearKitJob(
      turnOf([
        fromBro(
          "Заполни анкету: паспорт 4510 123456, СНИЛС 123-456-789 01, телефон +7 916 123-45-67, ИНН 770123456789."
        ),
      ])
    );

    const [state] = jev.askRouterQuestions.mock.lastCall ?? [];
    expect(state).toContain("Заполни анкету");
    expect(state).not.toMatch(/\d{3}/u);
  });

  it("hears a message Bro sent the busy task agent with the next turn's own", async () => {
    jev.askRouterQuestions.mockResolvedValueOnce(answer({ office: 0.97 }));
    await hearKitJob(turnOf([fromBro(job)]));
    const steered = fromBro(
      "И сделай QR для оплаты по реквизитам из карточки."
    );

    jev.askRouterQuestions.mockResolvedValueOnce(answer({ money: 0.97 }));
    await hearKitJob(
      turnOf([fromBro(job), steered, reply, fromBro("Пришли ссылку.")])
    );

    expect(jev.askRouterQuestions).toHaveBeenLastCalledWith(
      "И сделай QR для оплаты по реквизитам из карточки.\n\nПришли ссылку.",
      expect.any(Number),
      kitQuestions
    );
    expect(kitBlocksOfSession()).toEqual(["money", "office"]);
  });

  it("does not ask again about a message it heard: a replayed or resumed turn", async () => {
    jev.askRouterQuestions.mockResolvedValue(answer({ forms: 0.99 }));

    await hearKitJob(turnOf([fromBro(job)]));
    await hearKitJob(turnOf([fromBro(job)]));

    expect(jev.askRouterQuestions).toHaveBeenCalledTimes(1);
    // The job names its .docx: `office` comes in whatever Jev says.
    expect(kitBlocksOfSession()).toEqual(["forms", "office"]);
  });

  it("keeps every block for a session that ran turns before the pilot reached it", async () => {
    await hearKitJob(turnOf([fromBro(job), reply, fromBro("Пришли ссылку.")]));

    expect(jev.askRouterQuestions).not.toHaveBeenCalled();
    expect(kitBlocksOfSession()).toEqual(kitBlocks);
  });

  it("leaves a session outside the pilot without a decision", async () => {
    pilot.taskKitRouted.mockReturnValue(false);

    await hearKitJob(turnOf([fromBro(job)]));

    expect(jev.askRouterQuestions).not.toHaveBeenCalled();
    expect(kitBlocksOfSession()).toBeUndefined();
  });
});
