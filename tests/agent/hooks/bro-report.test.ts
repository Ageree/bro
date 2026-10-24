import type { SessionAuthContext } from "eve/context";
import type { HookContext } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Reports from "@db/services/bro-to-bro/reports";

vi.mock("eve/context", () => ({
  defineState<T>(_name: string, initial: () => T) {
    let value = initial();
    return {
      get: () => value,
      update(update: (current: T) => T) {
        value = update(value);
      },
    };
  },
}));

const outbox = vi.hoisted(() => ({
  finishBroReport: vi.fn<typeof Reports.finishBroReport>(),
  renewBroReportLease: vi.fn<typeof Reports.renewBroReportLease>(),
}));
vi.mock("@db/services/bro-to-bro/reports", () => outbox);

import reportHook from "@agent/hooks/bro-report";

const reportId = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";

function context(as: "report" | "person") {
  const current: SessionAuthContext =
    as === "report"
      ? {
          attributes: {
            broReportId: reportId,
            broReportToken: token,
            workspaceId: "workspace:user-1",
          },
          authenticator: "bro-result",
          principalId: "user-1",
          principalType: "user",
        }
      : {
          attributes: { workspaceId: "workspace:user-1" },
          authenticator: "telegram-webhook",
          principalId: "user-1",
          principalType: "user",
        };
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
      auth: { current, initiator: null },
      id: "session-1",
      turn: { id: "turn_0", sequence: 0 },
    },
  } satisfies HookContext;
}

type EventName = keyof NonNullable<typeof reportHook.events>;

async function emit(
  name: EventName,
  as: "report" | "person" = "report",
  data: Partial<typeof sent> = {}
) {
  // SAFETY: each case builds only the fields of the event the hook reads.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial event stands in for the stream event.
  await reportHook.events?.[name]?.({ data } as never, context(as));
}

const sent = {
  result: {
    callId: "call-1",
    isError: false,
    kind: "tool-result",
    output: { kind: "message", text: "Пётр согласен на ужин." },
    toolName: "send_message",
  },
  status: "completed",
};

describe("the Bro ↔ Bro report hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    outbox.finishBroReport.mockResolvedValue("delivered");
    outbox.renewBroReportLease.mockResolvedValue(true);
  });

  it("counts the report delivered once its turn sent a message, even after the owner steered in", async () => {
    await emit("turn.started");
    await emit("action.result", "person", sent);

    expect(outbox.finishBroReport).toHaveBeenCalledExactlyOnceWith(
      reportId,
      token,
      { delivered: true }
    );
  });

  it("puts the report back in line when its turn failed", async () => {
    await emit("turn.started");
    await emit("turn.failed");

    expect(outbox.finishBroReport).toHaveBeenCalledExactlyOnceWith(
      reportId,
      token,
      { delivered: false, error: "report turn failed", retry: true }
    );
  });
});
