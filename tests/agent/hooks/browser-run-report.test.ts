import type { HookContext } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const finishBrowserRunReport = vi.hoisted(() =>
  vi.fn<(runId: string) => Promise<void>>(() => Promise.resolve())
);
const renewBrowserRunReportLease = vi.hoisted(() =>
  vi.fn<(runId: string) => Promise<void>>(() => Promise.resolve())
);
const reopenBrowserRunReport = vi.hoisted(() =>
  vi.fn<(runId: string) => Promise<{ retried: boolean } | undefined>>(() =>
    Promise.resolve({ retried: true })
  )
);
vi.mock("@db/services/browser-runs", () => ({
  finishBrowserRunReport,
  renewBrowserRunReportLease,
  reopenBrowserRunReport,
}));

import reportHook from "@agent/hooks/browser-run-report";

const runId = "11111111-1111-4111-8111-111111111111";

function context(
  authenticator: string,
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
            browserRunId: runId,
            conversationChannel: "eve",
            workspaceId: "workspace:user-1",
          },
          authenticator,
          principalId: "user-1",
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

type Events = NonNullable<typeof reportHook.events>;
type EventName = keyof Events;
/** The part of an event the hook reads; the rest stays out of these cases. */
interface EventData {
  readonly code?: string;
  readonly result?: {
    readonly callId: string;
    readonly isError: boolean;
    readonly kind: "tool-result";
    readonly output: string | Readonly<Record<string, string>>;
    readonly toolName: string;
  };
  readonly status?: "completed";
}

async function emit(
  name: EventName,
  data: EventData,
  ctx = context("browser-result")
) {
  const handler = reportHook.events?.[name];
  // SAFETY: each case builds only the fields of the event the hook reads.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial event stands in for the stream event.
  await handler?.({ data } as never, ctx);
}

function toolResult(
  toolName: string,
  output: string | Readonly<Record<string, string>>,
  isError = false
): EventData {
  return {
    result: {
      callId: "call-1",
      isError,
      kind: "tool-result",
      output,
      toolName,
    },
    status: "completed",
  };
}

describe("the browser report hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the report's lease while its turn works on it", async () => {
    await emit("turn.started", {});

    expect(renewBrowserRunReportLease).toHaveBeenCalledExactlyOnceWith(runId);
  });

  it("counts the report delivered once a message reached the person", async () => {
    await emit(
      "action.result",
      toolResult("send_message", { kind: "message", text: "Нашёл три отеля" })
    );

    expect(finishBrowserRunReport).toHaveBeenCalledExactlyOnceWith(runId);
  });

  it("does not count a send the guard dropped", async () => {
    await emit(
      "action.result",
      toolResult("send_message", { skipped: "stale" })
    );

    expect(finishBrowserRunReport).not.toHaveBeenCalled();
    // The turn is still at work on the report: nobody sends it again.
    expect(renewBrowserRunReportLease).toHaveBeenCalledExactlyOnceWith(runId);
  });

  it("counts a continue on the errand, so a retry does not repeat it", async () => {
    await emit(
      "action.result",
      toolResult("browser_task", { runId, status: "running" })
    );
    await emit(
      "action.result",
      toolResult("browser_task", { message: "refused" }, true)
    );

    expect(finishBrowserRunReport).toHaveBeenCalledOnce();
  });

  it("puts the report back in line when its turn failed first", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await emit("turn.failed", { code: "MODEL_CALL_FAILED" });

    expect(reopenBrowserRunReport).toHaveBeenCalledExactlyOnceWith(runId);
    expect(finishBrowserRunReport).not.toHaveBeenCalled();
  });

  it("closes the report when its turn ends", async () => {
    await emit("turn.completed", {});

    expect(finishBrowserRunReport).toHaveBeenCalledExactlyOnceWith(runId);
  });

  it("leaves turns that no report started alone", async () => {
    await emit("turn.failed", { code: "MODEL_CALL_FAILED" }, context("authjs"));
    await emit("turn.completed", {}, context("authjs"));
    await emit(
      "turn.failed",
      { code: "MODEL_CALL_FAILED" },
      context("browser-result", {
        parent: {
          callId: "call-1",
          rootSessionId: "session-0",
          sessionId: "session-0",
          turn: { id: "turn-0", sequence: 0 },
        },
      })
    );

    expect(reopenBrowserRunReport).not.toHaveBeenCalled();
    expect(finishBrowserRunReport).not.toHaveBeenCalled();
  });
});
