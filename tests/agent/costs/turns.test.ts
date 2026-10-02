import type { HookContext } from "eve/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as usageCostRecords from "@db/services/usage-costs";

const recordUsageCost = vi.hoisted(() =>
  vi.fn<typeof usageCostRecords.recordUsageCost>(() => Promise.resolve(true))
);
vi.mock("@db/services/usage-costs", () => ({ recordUsageCost }));

import costsHook from "@agent/hooks/usage-costs";
import { turnCostSource, turnWorkspaceId } from "@agent/lib/costs/turns";

const workspaceId = "personal:0123456789abcdef0123456789abcdef";

type Caller = NonNullable<HookContext["session"]["auth"]["current"]>;

function caller(
  authenticator: string,
  attributes: Record<string, string> = {}
): Caller {
  return {
    attributes: { workspaceId, ...attributes },
    authenticator,
    principalId: "user-1",
    principalType: "user",
  };
}

function auth(current: Caller | null, initiator: Caller | null = current) {
  return { current, initiator };
}

function context(current: Caller | null, initiator: Caller | null = current) {
  return {
    agent: { name: "test-agent" },
    channel: {},
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    session: {
      auth: auth(current, initiator),
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
  } satisfies HookContext;
}

async function completeStep(
  ctx: HookContext,
  usage?: {
    readonly costUsd?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
  },
  hook: typeof costsHook = costsHook
) {
  const handler = hook.events?.["step.completed"];
  // SAFETY: the case builds only the fields of the event the hook reads.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial event stands in for the runtime's.
  const event = {
    data: {
      finishReason: "stop",
      sequence: 3,
      stepIndex: 1,
      turnId: "turn-1",
      usage,
    },
    meta: { at: "2026-09-30T10:00:00.000Z", id: "event-1" },
    type: "step.completed",
  } as never;
  await handler?.(event, ctx);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("whose turn a model step is", () => {
  it("is the person's on every channel they write through", () => {
    for (const authenticator of [
      "authjs",
      "local-dev",
      "photon-imessage",
      "telegram-webhook",
    ]) {
      expect(turnCostSource(auth(caller(authenticator)))).toEqual({
        runId: undefined,
        source: "chat",
      });
    }
  });

  it("is a browser report's, with its run, when a run's report opened it", () => {
    expect(
      turnCostSource(
        auth(
          caller("browser-result", { browserRunId: "run-1" }),
          caller("authjs")
        )
      )
    ).toEqual({ runId: "run-1", source: "browser-report" });
  });

  it("is Bro's own for a schedule's worker, a mail check and a schedule's report", () => {
    for (const current of [
      caller("scheduled-worker"),
      caller("scheduled-worker", { scheduledRunKind: "proactive" }),
      caller("scheduled-result"),
    ]) {
      expect(turnCostSource(auth(current)).source).toBe("background");
    }
  });

  it("ties Bro's own turn to its scheduled run", () => {
    expect(
      turnCostSource(
        auth(caller("scheduled-result", { scheduledRunId: "run-7" }))
      )
    ).toEqual({ runId: "run-7", source: "background" });
    expect(turnCostSource(auth(caller("scheduled-worker"))).runId).toBe(
      undefined
    );
  });

  it("finds the workspace on the caller, or on the one who opened the session", () => {
    expect(turnWorkspaceId(auth(caller("authjs")))).toBe(workspaceId);
    expect(turnWorkspaceId(auth(null, caller("authjs")))).toBe(workspaceId);
    expect(turnWorkspaceId(auth(null, null))).toBeUndefined();
  });
});

describe("recording a model step", () => {
  it("writes the step once per its coordinates, in roubles from OpenRouter's dollars", async () => {
    await completeStep(context(caller("telegram-webhook")), {
      cacheReadTokens: 30_000,
      costUsd: 0.01,
      inputTokens: 65_000,
      outputTokens: 400,
    });

    expect(recordUsageCost).toHaveBeenCalledExactlyOnceWith({
      costRub: 0.8441,
      costUsd: 0.01,
      idempotencyKey: "step:session-1:turn-1:1",
      occurredAt: new Date("2026-09-30T10:00:00.000Z"),
      runId: null,
      sessionId: "session-1",
      source: "chat",
      units: {
        cachedInputTokens: 30_000,
        inputTokens: 65_000,
        outputTokens: 400,
        steps: 1,
        unpriced: false,
      },
      workspaceId,
    });
  });

  it("keeps RouterAI's roubles and writes no dollars for them", async () => {
    vi.resetModules();
    vi.stubEnv("MODEL_PROVIDER", "routerai");
    vi.stubEnv("ROUTERAI_API_KEY", "routerai-test-key");
    const routerAiHook = (await import("@agent/hooks/usage-costs")).default;
    // The other cases keep the Gateway setup of `tests/setup-env.ts`.
    vi.stubEnv("MODEL_PROVIDER", "");
    vi.stubEnv("ROUTERAI_API_KEY", "");

    // 0.31 ₽ reaches eve as dollars at USAGE_USD_RUB.
    await completeStep(
      context(caller("authjs")),
      { costUsd: 0.31 / 84.41, inputTokens: 10 },
      routerAiHook
    );

    expect(recordUsageCost).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ costRub: 0.31, costUsd: null })
    );
  });

  it("ties a browser report's step to its run and keeps an unpriced step at zero", async () => {
    await completeStep(
      context(caller("browser-result", { browserRunId: "run-1" })),
      { inputTokens: 10 }
    );

    expect(recordUsageCost).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        costRub: 0,
        costUsd: null,
        runId: "run-1",
        source: "browser-report",
      })
    );
    expect(recordUsageCost.mock.calls[0]?.[0].units?.unpriced).toBe(true);
  });

  it("skips a turn with no workspace and never fails a turn on the accounting", async () => {
    await completeStep(context(null, null), { costUsd: 0.01 });
    expect(recordUsageCost).not.toHaveBeenCalled();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recordUsageCost.mockRejectedValueOnce(new Error("database is down"));
    await expect(
      completeStep(context(caller("authjs")), { costUsd: 0.01 })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
