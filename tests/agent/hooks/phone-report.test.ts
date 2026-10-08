import type { SessionAuthContext } from "eve/context";
import type { HookContext } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const finishPhoneReport = vi.hoisted(() =>
  vi.fn<(id: string, token: string, delivered: boolean) => Promise<boolean>>(
    () => Promise.resolve(true)
  )
);
const renewPhoneReportLease = vi.hoisted(() =>
  vi.fn<
    (
      scope: { userId: string; workspaceId: string },
      id: string,
      token: string
    ) => Promise<boolean>
  >(() => Promise.resolve(true))
);
vi.mock("@db/services/phone", () => ({
  finishPhoneReport,
  renewPhoneReportLease,
}));

import reportHook from "@agent/hooks/phone-report";

const callId = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";

function context(
  as: "report" | "person",
  session: Partial<Pick<HookContext["session"], "parent" | "turn">> = {}
) {
  const current: SessionAuthContext =
    as === "report"
      ? {
          attributes: {
            phoneCallId: callId,
            phoneReportToken: token,
            workspaceId: "workspace:user-1",
          },
          authenticator: "phone-result",
          principalId: "user-1",
          principalType: "user",
        }
      : {
          attributes: { workspaceId: "workspace:user-1" },
          authenticator: "telegram",
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
      ...session,
    },
  } satisfies HookContext;
}

type Events = NonNullable<typeof reportHook.events>;
type EventName = keyof Events;

interface EventData {
  readonly result?: {
    readonly callId: string;
    readonly isError: boolean;
    readonly kind: "tool-result";
    readonly output: Readonly<Record<string, string>>;
    readonly toolName: string;
  };
  readonly status?: "completed";
}

async function emit(
  name: EventName,
  as: "report" | "person" = "report",
  data: EventData = {},
  session: Parameters<typeof context>[1] = {}
) {
  // SAFETY: each case builds only the fields of the event the hook reads.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial event stands in for the stream event.
  await reportHook.events?.[name]?.({ data } as never, context(as, session));
}

const sent: EventData = {
  result: {
    callId: "call-1",
    isError: false,
    kind: "tool-result",
    output: { kind: "message", text: "Звонок завершён." },
    toolName: "send_message",
  },
  status: "completed",
};

describe("the phone report hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("renews the lease while the report's turn works", async () => {
    await emit("turn.started");
    await emit("step.started");

    expect(renewPhoneReportLease).toHaveBeenCalledTimes(2);
    expect(renewPhoneReportLease).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace:user-1" },
      callId,
      token
    );
  });

  it("counts the report delivered once a message got through", async () => {
    await emit("turn.started");
    await emit("action.result", "report", sent);

    expect(finishPhoneReport).toHaveBeenCalledExactlyOnceWith(
      callId,
      token,
      true
    );
  });

  it("counts the report delivered when its turn ends without a message", async () => {
    await emit("turn.started");
    await emit("turn.completed");

    expect(finishPhoneReport).toHaveBeenCalledExactlyOnceWith(
      callId,
      token,
      true
    );
    expect(console.info).toHaveBeenCalledWith(
      "[phone] report turn ended without a message",
      { callId, sessionId: "session-1" }
    );
  });

  it("does not say a turn ended silently when a message already settled the report", async () => {
    finishPhoneReport.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await emit("turn.started");
    await emit("action.result", "report", sent);
    await emit("turn.completed");

    expect(console.info).not.toHaveBeenCalled();
  });

  it("counts a cancelled turn as settled and says it said nothing", async () => {
    await emit("turn.started");
    await emit("turn.cancelled");

    expect(finishPhoneReport).toHaveBeenCalledExactlyOnceWith(
      callId,
      token,
      true
    );
    expect(console.warn).toHaveBeenCalledWith(
      "[phone] report turn cancelled before a message",
      { callId, sessionId: "session-1" }
    );
  });

  it("puts a failed turn back in line", async () => {
    await emit("turn.started");
    await emit("turn.failed");

    expect(finishPhoneReport).toHaveBeenCalledExactlyOnceWith(
      callId,
      token,
      false
    );
  });

  it("still finds the report after a person's message took over the turn", async () => {
    await emit("turn.started");
    await emit("step.started", "person");
    await emit("action.result", "person", sent);
    await emit("turn.completed", "person");

    expect(renewPhoneReportLease).toHaveBeenCalledTimes(3);
    expect(renewPhoneReportLease).toHaveBeenLastCalledWith(
      { userId: "user-1", workspaceId: "workspace:user-1" },
      callId,
      token
    );
    expect(finishPhoneReport).toHaveBeenCalledTimes(2);
    expect(finishPhoneReport).toHaveBeenCalledWith(callId, token, true);
  });

  it("forgets the report when its turn ends", async () => {
    await emit("turn.started");
    await emit("turn.completed");
    finishPhoneReport.mockClear();
    renewPhoneReportLease.mockClear();

    // The next turn has the same id (eve numbers turns per run) but is a
    // person's own.
    await emit("turn.started", "person");
    await emit("step.started", "person");
    await emit("turn.completed", "person");

    expect(renewPhoneReportLease).not.toHaveBeenCalled();
    expect(finishPhoneReport).not.toHaveBeenCalled();
  });

  it("does not take another turn of the session for the report", async () => {
    await emit("turn.started");
    await emit(
      "turn.completed",
      "person",
      {},
      { turn: { id: "turn_1", sequence: 1 } }
    );

    expect(finishPhoneReport).not.toHaveBeenCalled();
  });

  it("leaves a subagent's turn alone", async () => {
    const parent = {
      callId: "call-1",
      rootSessionId: "root-1",
      sessionId: "parent-1",
      turn: { id: "turn_0", sequence: 0 },
    };
    await emit("turn.started", "report", {}, { parent });
    await emit("turn.completed", "report", {}, { parent });

    expect(renewPhoneReportLease).not.toHaveBeenCalled();
    expect(finishPhoneReport).not.toHaveBeenCalled();
  });
});
