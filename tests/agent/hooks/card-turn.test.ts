import type { HookContext, HookEvent } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  finish: vi.fn<(id: string, now: Date) => Promise<void>>(() =>
    Promise.resolve()
  ),
  link: vi.fn<(id: string, runId: string) => Promise<void>>(() =>
    Promise.resolve()
  ),
}));
vi.mock("eve/context", () => ({
  defineState: <T>(_name: string, initial: () => T) => {
    let value = initial();
    return {
      get: () => value,
      update: (change: (current: T) => T) => {
        value = change(value);
      },
    };
  },
}));
vi.mock("@db/services/cards", () => ({
  finishCardResponse: services.finish,
  linkCardResponseRun: services.link,
}));
vi.mock("@shared/cards/pilot", () => ({ cardsEnabled: () => true }));

import cardTurnHook from "@agent/hooks/card-turn";

const press = "0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e11";

function context(
  authenticator = "card-answer",
  session: Pick<HookContext["session"], "parent"> = {}
) {
  return {
    agent: { name: "test-agent" },
    channel: { continuationToken: "conversation" },
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    session: {
      auth: {
        current: {
          attributes: {
            cardRef: "k7m2p9qa",
            cardResponseId: press,
            conversationChannel: "telegram",
            conversationId: "4242::",
            workspaceId: "workspace:alice",
          },
          authenticator,
          principalId: "alice",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
      ...session,
    },
  } satisfies HookContext;
}

type EventName = keyof NonNullable<typeof cardTurnHook.events>;

async function emit(
  name: EventName,
  data: Partial<HookEvent<EventName>["data"]>,
  ctx = context()
) {
  const handler = cardTurnHook.events?.[name];
  // SAFETY: each case builds only the fields of the event the hook reads.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial event stands in for the stream event.
  await handler?.({ data } as never, ctx);
}

function browserResult(output: Record<string, string>, isError = false) {
  return {
    result: {
      callId: "call-1",
      isError,
      kind: "tool-result" as const,
      output,
      toolName: "browser_task",
    },
    status: "completed" as const,
  };
}

describe("the turn of a card's press", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets the card's next press go once the turn is over, however it ends", async () => {
    await emit("turn.started", {});
    await emit("turn.completed", {});
    await emit("turn.started", {});
    await emit("turn.failed", { code: "model" });
    await emit("turn.started", {});
    await emit("turn.cancelled", {});

    expect(services.finish.mock.calls.map(([id]) => id)).toEqual([
      press,
      press,
      press,
    ]);
  });

  it("remembers the browser run the turn left at work, and no other", async () => {
    await emit("turn.started", {});
    await emit(
      "action.result",
      browserResult({ runId: "run-1", status: "running" })
    );
    await emit(
      "action.result",
      browserResult({ outcome: "Нашёл", runId: "run-2", status: "done" })
    );
    await emit(
      "action.result",
      browserResult({ runId: "run-3", status: "running" }, true)
    );
    await emit("action.result", {
      ...browserResult({ runId: "run-4", status: "running" }),
      result: {
        callId: "call-2",
        kind: "tool-result",
        output: { runId: "run-4", status: "running" },
        toolName: "web_search",
      },
    });

    expect(services.link).toHaveBeenCalledExactlyOnceWith(press, "run-1");
  });

  it("leaves every other turn alone, a subagent's too", async () => {
    await emit("turn.started", {}, context("telegram-webhook"));
    await emit("turn.completed", {}, context("telegram-webhook"));
    await emit(
      "action.result",
      browserResult({ runId: "run-1", status: "running" }),
      context("card-answer", {
        parent: {
          callId: "call-1",
          rootSessionId: "session-0",
          sessionId: "session-0",
          turn: { id: "turn-0", sequence: 0 },
        },
      })
    );

    expect(services.finish).not.toHaveBeenCalled();
    expect(services.link).not.toHaveBeenCalled();
  });

  it("logs a write that failed and lets the turn go on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    services.finish.mockRejectedValueOnce(new Error("connection reset"));

    await emit("turn.started", {});
    await emit("turn.completed", {});

    expect(warn).toHaveBeenCalledWith(
      "[cards] the press's turn was not recorded",
      {
        name: "Error",
        press,
      }
    );
    warn.mockRestore();
  });

  it("keeps the press when a person's message takes over the caller mid-turn", async () => {
    await emit("turn.started", {});
    await emit("turn.completed", {}, context("telegram-webhook"));

    expect(services.finish).toHaveBeenCalledExactlyOnceWith(
      press,
      expect.any(Date)
    );
  });
});
