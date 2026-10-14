import type { HookContext } from "eve/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as turnLogService from "@db/services/turn-log";
import type { alertOwner } from "@agent/lib/owner-alert";
import type * as secrets from "@agent/lib/privacy/secrets";
import type turnLogHook from "@agent/hooks/turn-log";
import { accessScopeForUser } from "@shared/identity/access-scope";

const mocks = vi.hoisted(() => ({
  alertOwner: vi.fn<typeof alertOwner>(),
  appendTurnEntries: vi.fn<typeof turnLogService.appendTurnEntries>(),
  countFailedPeople: vi.fn<typeof turnLogService.countFailedPeople>(),
  recordTurnEnd: vi.fn<typeof turnLogService.recordTurnEnd>(),
  recordTurnStart: vi.fn<typeof turnLogService.recordTurnStart>(),
  recordTurnStep: vi.fn<typeof turnLogService.recordTurnStep>(),
  recordTurnTools: vi.fn<typeof turnLogService.recordTurnTools>(),
  withoutSecrets: vi.fn<typeof secrets.withoutSecrets>(),
  workspaceAccounts: vi.fn<typeof turnLogService.workspaceAccounts>(),
}));

vi.mock("@db/services/turn-log", async (importOriginal) => ({
  ...(await importOriginal<typeof turnLogService>()),
  appendTurnEntries: mocks.appendTurnEntries,
  countFailedPeople: mocks.countFailedPeople,
  recordTurnEnd: mocks.recordTurnEnd,
  recordTurnStart: mocks.recordTurnStart,
  recordTurnStep: mocks.recordTurnStep,
  recordTurnTools: mocks.recordTurnTools,
  workspaceAccounts: mocks.workspaceAccounts,
}));

vi.mock("@agent/lib/owner-alert", () => ({ alertOwner: mocks.alertOwner }));

const actualSecrets = await vi.importActual<typeof secrets>(
  "@agent/lib/privacy/secrets"
);
vi.mock("@agent/lib/privacy/secrets", () => ({
  withoutSecrets: mocks.withoutSecrets,
}));

const scope = accessScopeForUser("better-auth:alice");

type Caller = NonNullable<HookContext["session"]["auth"]["current"]>;

function caller(authenticator = "telegram-webhook"): Caller {
  return {
    attributes: { workspaceId: scope.workspaceId },
    authenticator,
    principalId: scope.userId,
    principalType: "user",
  };
}

function context(current: Caller = caller()) {
  return {
    agent: { name: "test-agent" },
    channel: { kind: "channel:telegram" },
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    session: {
      auth: { current, initiator: current },
      id: "session-1",
      turn: { id: "turn_1", sequence: 1 },
    },
  } satisfies HookContext;
}

type Events = NonNullable<(typeof turnLogHook)["events"]>;
type EventOf<K extends keyof Events> = Parameters<NonNullable<Events[K]>>[0];

const meta = { at: "2026-10-12T07:00:00.000Z", id: "event-1" };

async function loadHook(transcripts: "on" | "off") {
  vi.resetModules();
  vi.stubEnv("OWNER_TRANSCRIPTS", transcripts);
  const hook = (await import("@agent/hooks/turn-log")).default;
  const events = hook.events;
  if (!events) throw new Error("The hook must listen.");
  return events;
}

function handler<K extends keyof Events>(events: Events, key: K) {
  const run = events[key];
  if (!run) throw new Error(`The hook must listen to ${key}.`);
  return run;
}

function started(): EventOf<"turn.started"> {
  return {
    data: { sequence: 1, turnId: "turn_1" },
    meta,
    type: "turn.started",
  };
}

function received(message: string): EventOf<"message.received"> {
  return {
    data: { message, sequence: 1, turnId: "turn_1" },
    meta,
    type: "message.received",
  };
}

function sendMessage(text: string): EventOf<"actions.requested"> {
  return {
    data: {
      actions: [
        {
          callId: "call-1",
          input: { text },
          kind: "tool-call",
          toolName: "send_message",
        },
      ],
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
    },
    meta,
    type: "actions.requested",
  };
}

function failed(statusCode?: number): EventOf<"turn.failed"> {
  const data: EventOf<"turn.failed">["data"] = {
    code: "MODEL_CALL_FAILED",
    message: "Insufficient balance for «пароль qwerty»",
    sequence: 1,
    turnId: "turn_1",
  };
  if (statusCode !== undefined) data.details = { statusCode };
  return { data, meta, type: "turn.failed" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.alertOwner.mockResolvedValue(true);
  mocks.appendTurnEntries.mockResolvedValue();
  mocks.countFailedPeople.mockResolvedValue(1);
  mocks.withoutSecrets.mockImplementation(actualSecrets.withoutSecrets);
  mocks.recordTurnEnd.mockResolvedValue(undefined);
  mocks.recordTurnStart.mockResolvedValue();
  mocks.recordTurnStep.mockResolvedValue();
  mocks.recordTurnTools.mockResolvedValue();
  mocks.workspaceAccounts.mockResolvedValue(
    new Map([
      [
        scope.workspaceId,
        {
          createdAt: new Date(meta.at),
          email: "alice@example.com",
          name: "Алиса",
          phoneNumber: "+79990001122",
        },
      ],
    ])
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv("OWNER_TRANSCRIPTS", "off");
});

describe("the turn log hook", () => {
  it("records a person's turn with its channel, caller and start", async () => {
    const events = await loadHook("off");
    await handler(events, "turn.started")(started(), context());

    expect(mocks.recordTurnStart).toHaveBeenCalledWith({
      channel: "telegram",
      kind: "person",
      runId: null,
      sessionId: "session-1",
      startedAt: new Date(meta.at),
      turnId: "turn_1",
      userId: scope.userId,
      workspaceId: scope.workspaceId,
    });
  });

  it("files a browser run's report and a schedule's worker by their kind", async () => {
    const events = await loadHook("off");
    await handler(events, "turn.started")(
      started(),
      context({
        ...caller("browser-result"),
        attributes: { browserRunId: "run-3", workspaceId: scope.workspaceId },
      })
    );
    await handler(events, "turn.started")(
      started(),
      context({
        attributes: {
          scheduledRunId: "run-7",
          workspaceId: scope.workspaceId,
        },
        authenticator: "scheduled-worker",
        principalId: "scheduler",
        principalType: "service",
      })
    );

    expect(mocks.recordTurnStart.mock.calls.map(([turn]) => turn.kind)).toEqual(
      ["browser-report", "background"]
    );
    expect(mocks.recordTurnStart.mock.lastCall?.[0].runId).toBe("run-7");
  });

  it("never fails the turn when a write fails, and logs no text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const events = await loadHook("on");
    const failure = new Error("Failed query: insert … params: пароль qwerty");
    mocks.recordTurnStart.mockRejectedValue(failure);
    mocks.appendTurnEntries.mockRejectedValue(failure);
    mocks.recordTurnEnd.mockRejectedValue(failure);

    await expect(
      handler(events, "turn.started")(started(), context())
    ).resolves.toBeUndefined();
    await expect(
      handler(events, "message.received")(received("пароль qwerty"), context())
    ).resolves.toBeUndefined();
    await expect(
      handler(events, "turn.completed")(
        {
          data: { sequence: 1, turnId: "turn_1" },
          meta,
          type: "turn.completed",
        },
        context()
      )
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("qwerty");
  });

  it("keeps no text while OWNER_TRANSCRIPTS is off, but still the tools", async () => {
    const events = await loadHook("off");
    await handler(events, "message.received")(
      received("Найди билеты в Казань"),
      context()
    );
    await handler(events, "actions.requested")(
      {
        data: {
          actions: [
            {
              callId: "call-1",
              input: { text: "Ищу" },
              kind: "tool-call",
              toolName: "send_message",
            },
          ],
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        },
        meta,
        type: "actions.requested",
      },
      context()
    );
    await handler(events, "message.completed")(
      {
        data: {
          finishReason: "stop",
          message: "Готово",
          sequence: 1,
          stepIndex: 1,
          turnId: "turn_1",
        },
        meta,
        type: "message.completed",
      },
      context()
    );

    expect(mocks.appendTurnEntries).not.toHaveBeenCalled();
    expect(mocks.recordTurnTools).toHaveBeenCalledWith(
      { sessionId: "session-1", turnId: "turn_1" },
      ["send_message"]
    );
  });

  it("keeps the turn's text with codes, passwords and cards cut out", async () => {
    const events = await loadHook("on");
    await handler(events, "message.received")(
      received(
        "Код из смс 739204, пароль от почты Kot2024, карта 4276 1234 5678 9012"
      ),
      context()
    );
    await handler(events, "actions.requested")(
      {
        data: {
          actions: [
            {
              callId: "call-1",
              input: { text: "Вошёл с паролем: Kot2024" },
              kind: "tool-call",
              toolName: "send_message",
            },
            {
              callId: "call-2",
              input: { password: "hunter2", site: "example.com" },
              kind: "tool-call",
              toolName: "browser_task",
            },
          ],
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        },
        meta: { at: meta.at, id: "event-2" },
        type: "actions.requested",
      },
      context()
    );

    const lines = mocks.appendTurnEntries.mock.calls.flatMap(([rows]) => rows);
    expect(
      lines.map(({ part, role, text, toolName }) => ({
        part,
        role,
        text,
        toolName,
      }))
    ).toEqual([
      {
        part: "",
        role: "person",
        text: "Код из смс [удалено], пароль от почты [удалено] карта [удалено]",
        toolName: null,
      },
      {
        part: "call-1",
        role: "bro",
        text: "Вошёл с паролем: [удалено]",
        toolName: "send_message",
      },
      {
        part: "call-2",
        role: "tool-call",
        text: '{"site":"example.com"}',
        toolName: "browser_task",
      },
    ]);
    const all = JSON.stringify(lines);
    for (const secret of ["739204", "Kot2024", "9012", "hunter2"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("cuts a tool's long result to 2000 characters", async () => {
    const events = await loadHook("on");
    await handler(events, "action.result")(
      {
        data: {
          result: {
            callId: "call-3",
            kind: "tool-result",
            output: { page: "Казань ".repeat(2000) },
            toolName: "web_fetch",
          },
          sequence: 1,
          status: "completed",
          stepIndex: 0,
          turnId: "turn_1",
        },
        meta,
        type: "action.result",
      },
      context()
    );

    const [line] = mocks.appendTurnEntries.mock.lastCall?.[0] ?? [];
    expect(line?.role).toBe("tool-result");
    expect(line?.text.length).toBeLessThanOrEqual(2000);
  });

  it("tells the owner of a person's failed turn without its text", async () => {
    const events = await loadHook("off");
    await handler(events, "turn.failed")(failed(400), context());
    await vi.waitFor(() => {
      expect(mocks.alertOwner).toHaveBeenCalledTimes(1);
    });

    expect(mocks.recordTurnEnd).toHaveBeenCalledWith(
      { sessionId: "session-1", turnId: "turn_1" },
      {
        endedAt: new Date(meta.at),
        errorCode: "MODEL_CALL_FAILED 400",
        outcome: "failed",
      }
    );
    const [key, text, options] = mocks.alertOwner.mock.calls[0] ?? [];
    expect(key).toBe(`turn-failed:${scope.workspaceId}:MODEL_CALL_FAILED 400`);
    expect(text).toContain("Алиса (+79990001122)");
    expect(text).toContain("telegram");
    expect(text).toContain("MODEL_CALL_FAILED 400");
    expect(text).not.toContain("qwerty");
    expect(options?.repeatAfterMs).toBe(60 * 60_000);
    expect(options?.kind).toBe("alert");
  });

  it("does not tell the owner of Bro's own failed turn", async () => {
    const events = await loadHook("off");
    await handler(events, "turn.failed")(
      failed(),
      context(caller("browser-result"))
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.recordTurnEnd).toHaveBeenCalled();
    expect(mocks.alertOwner).not.toHaveBeenCalled();
  });

  // Review of U3a: eve fails the turn on a hook's exception, and the text
  // was made outside the guard.
  it("never fails the turn when the text filter throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.withoutSecrets.mockImplementation(() => {
      throw new RangeError("filter broke");
    });
    const events = await loadHook("on");

    await expect(
      handler(events, "actions.requested")(sendMessage("Готово"), context())
    ).resolves.toBeUndefined();
    await expect(
      handler(events, "message.received")(received("Привет"), context())
    ).resolves.toBeUndefined();
    await expect(
      handler(events, "action.result")(
        {
          data: {
            result: {
              callId: "call-1",
              kind: "tool-result",
              output: { ok: true },
              toolName: "web_fetch",
            },
            sequence: 1,
            status: "completed",
            stepIndex: 0,
            turnId: "turn_1",
          },
          meta,
          type: "action.result",
        },
        context()
      )
    ).resolves.toBeUndefined();

    expect(mocks.appendTurnEntries).not.toHaveBeenCalled();
    expect(mocks.recordTurnTools).toHaveBeenCalled();
    // Three failed transcript writes, and the message log's two lines.
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it("logs message text whatever the flag says", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const events = await loadHook("off");

    await handler(events, "message.received")(received("Привет"), context());

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toBe("[message]");
    expect(JSON.stringify(info.mock.calls[0]?.[1])).toContain("Привет");
    expect(mocks.appendTurnEntries).not.toHaveBeenCalled();
  });

  // Review of U3a: a sign-in window and a shared file open to whoever
  // holds the link.
  it("cuts sign-in and shared-file links out of the text", async () => {
    const events = await loadHook("on");
    await handler(events, "actions.requested")(
      sendMessage(
        "Войди тут: https://brobro.tech/handoff/uU9hry_OH-oo21PlwBlXGYQD и файл https://brobro.tech/eve/v1/sandbox-files/abc123/report.pdf?sig=deadbeef готов"
      ),
      context()
    );

    const [line] = mocks.appendTurnEntries.mock.lastCall?.[0] ?? [];
    expect(line?.text).toBe("Войди тут: [удалено] и файл [удалено] готов");
  });

  it("reads only the head of a huge result", async () => {
    const events = await loadHook("on");
    const output = { page: `${" ".repeat(10)}${"а".repeat(3_000_000)}` };
    await handler(events, "action.result")(
      {
        data: {
          result: {
            callId: "call-1",
            kind: "tool-result",
            output,
            toolName: "web_fetch",
          },
          sequence: 1,
          status: "completed",
          stepIndex: 0,
          turnId: "turn_1",
        },
        meta,
        type: "action.result",
      },
      context()
    );

    const [line] = mocks.appendTurnEntries.mock.lastCall?.[0] ?? [];
    expect(line?.text).toBe(`{"page":"${" ".repeat(10)}${"а".repeat(1981)}`);
  });

  // Review of U3a: a provider's 402 fails every person, and the owner got
  // an alert per person.
  it("tells one alert for a provider's outage, with how many it reached", async () => {
    const events = await loadHook("off");
    mocks.countFailedPeople.mockResolvedValue(2);
    const bob = accessScopeForUser("better-auth:bob");
    await handler(events, "turn.failed")(failed(402), context());
    await handler(events, "turn.failed")(
      failed(402),
      context({
        ...caller(),
        attributes: { workspaceId: bob.workspaceId },
        principalId: bob.userId,
      })
    );
    await vi.waitFor(() => {
      expect(mocks.alertOwner).toHaveBeenCalledTimes(2);
    });

    const keys = mocks.alertOwner.mock.calls.map(([key]) => key);
    expect(keys).toEqual([
      "turn-failed:provider:MODEL_CALL_FAILED 402",
      "turn-failed:provider:MODEL_CALL_FAILED 402",
    ]);
    expect(mocks.alertOwner.mock.calls[0]?.[1]).toContain(
      "Людей за последний час: 2"
    );
    expect(mocks.countFailedPeople).toHaveBeenCalledWith(
      "MODEL_CALL_FAILED 402",
      new Date(new Date(meta.at).getTime() - 60 * 60_000)
    );
  });

  it("keeps a person's own failure keyed by them", async () => {
    const events = await loadHook("off");
    await handler(events, "turn.failed")(failed(400), context());
    await vi.waitFor(() => {
      expect(mocks.alertOwner).toHaveBeenCalledTimes(1);
    });
    expect(mocks.alertOwner.mock.calls[0]?.[0]).toBe(
      `turn-failed:${scope.workspaceId}:MODEL_CALL_FAILED 400`
    );
    expect(mocks.countFailedPeople).not.toHaveBeenCalled();
  });
});
