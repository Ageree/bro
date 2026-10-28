import type { HookContext } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type workLogHook from "@agent/hooks/work-log";
import type { appendWorkLine } from "@db/services/work-log";
import { accessScopeForUser } from "@shared/identity/access-scope";

const mocks = vi.hoisted(() => ({
  appendWorkLine: vi.fn<typeof appendWorkLine>(),
  enabled: vi.fn<() => boolean>(),
}));

vi.mock("@db/services/work-log", () => ({
  appendWorkLine: mocks.appendWorkLine,
  workLineLimit: 2000,
}));
vi.mock("@agent/lib/work-log/pilot", () => ({
  workLogEnabled: mocks.enabled,
}));

const { default: hook } = await import("@agent/hooks/work-log");

const scope = accessScopeForUser("better-auth:alice");

type Caller = NonNullable<HookContext["session"]["auth"]["current"]>;
const person: Caller = {
  attributes: { workspaceId: scope.workspaceId },
  authenticator: "authjs",
  principalId: scope.userId,
  principalType: "user",
};

function context(options: { readonly subagent?: boolean } = {}) {
  return {
    agent: { name: "test-agent" },
    channel: { kind: "channel:eve" },
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    session: {
      auth: { current: person, initiator: person },
      id: "session-1",
      ...(options.subagent === true && {
        parent: {
          callId: "call-0",
          rootSessionId: "session-0",
          sessionId: "session-0",
          turn: { id: "turn_0", sequence: 0 },
        },
      }),
      turn: { id: "turn_1", sequence: 1 },
    },
  } satisfies HookContext;
}

type HookEvents = NonNullable<(typeof workLogHook)["events"]>;
type ReceivedEvent = Parameters<NonNullable<HookEvents["message.received"]>>[0];
type ResultEvent = Parameters<NonNullable<HookEvents["action.result"]>>[0];
type RequestedEvent = Parameters<
  NonNullable<HookEvents["actions.requested"]>
>[0];

const meta = { at: "2026-10-28T11:00:00.000Z", id: "event-1" };

function received(
  message: string,
  parts?: ReceivedEvent["data"]["parts"]
): ReceivedEvent {
  return {
    data: { message, parts, sequence: 1, turnId: "turn_1" },
    meta,
    type: "message.received",
  };
}

function sent(
  text: string,
  status: "completed" | "failed" = "completed"
): ResultEvent {
  return {
    data: {
      result: {
        callId: "call-1",
        kind: "tool-result",
        output: { kind: "message", text },
        toolName: "send_message",
      },
      sequence: 2,
      status,
      stepIndex: 0,
      turnId: "turn_1",
    },
    meta,
    type: "action.result",
  };
}

function asked(toolName: string, turnId: string): RequestedEvent {
  return {
    data: {
      actions: [{ callId: "call-0", input: {}, kind: "tool-call", toolName }],
      sequence: 1,
      stepIndex: 0,
      turnId,
    },
    meta,
    type: "actions.requested",
  };
}

function inTurn<T extends { data: { turnId: string } }>(
  event: T,
  turnId: string
): T {
  return { ...event, data: { ...event.data, turnId } };
}

async function receive(event: ReceivedEvent, ctx: HookContext = context()) {
  await hook.events?.["message.received"]?.(event, ctx);
}

async function result(event: ResultEvent, ctx: HookContext = context()) {
  await hook.events?.["action.result"]?.(event, ctx);
}

async function requested(event: RequestedEvent, ctx: HookContext = context()) {
  await hook.events?.["actions.requested"]?.(event, ctx);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.appendWorkLine.mockResolvedValue();
});

describe("the work log hook", () => {
  it("keeps the person's request with its files' names and Bro's delivered message", async () => {
    // eve's summary of a web message names each file again, with its type.
    await receive(
      received("Разбери договор\n[file: Договор.pdf (application/pdf)]", [
        { text: "Разбери договор", type: "text" },
        {
          filename: "Договор.pdf",
          mediaType: "application/pdf",
          type: "file",
        },
      ])
    );
    await result(sent("Штраф — 0,1% за каждый час сверх шести."));
    // A send the delivery refused never reached the person.
    await result(sent("Не дошло", "failed"));

    expect(mocks.appendWorkLine.mock.calls).toEqual([
      [
        scope.workspaceId,
        {
          channel: "channel:eve",
          createdAt: new Date(meta.at),
          files: ["Договор.pdf"],
          role: "person",
          sessionId: "session-1",
          text: "Разбери договор",
          turnId: "turn_1",
        },
      ],
      [
        scope.workspaceId,
        expect.objectContaining({
          files: [],
          role: "bro",
          text: "Штраф — 0,1% за каждый час сверх шести.",
        }),
      ],
    ]);
  });

  it("cuts one-time codes and links out of what it keeps", async () => {
    await result(
      sent(
        "Код из письма сайта — 739204, ввёл его. Карточка: https://brobro.tech/card/abc, [отель](https://ostrovok.ru/h/1)."
      )
    );

    expect(mocks.appendWorkLine.mock.lastCall?.[1].text).toBe(
      "Код из письма сайта — [удалено], ввёл его. Карточка: [ссылка] отель."
    );
  });

  it("keeps a voice turn's answer only when the turn did something besides answering", async () => {
    // Told from the records: a wrong figure here would become one.
    await receive(
      inTurn(received("[голосом]\nКакая маржа на рафе?"), "turn_1")
    );
    await requested(asked("profile__find", "turn_1"));
    await result(inTurn(sent("Маржа 197 ₽."), "turn_1"));
    // Searched: what it found is new.
    await receive(inTurn(received("[голосом]\nКакой курс доллара?"), "turn_2"));
    await requested(asked("web_search", "turn_2"));
    await result(inTurn(sent("Доллар — 81,4 ₽."), "turn_2"));

    expect(
      mocks.appendWorkLine.mock.calls.map(([, line]) => [line.role, line.text])
    ).toEqual([
      ["person", "Какая маржа на рафе?"],
      ["person", "Какой курс доллара?"],
      ["bro", "Доллар — 81,4 ₽."],
    ]);
  });

  it("keeps nothing outside the pilot or from a subagent", async () => {
    await result(sent("Готово."), context({ subagent: true }));
    mocks.enabled.mockReturnValue(false);
    await receive(received("Разбери договор"));
    await result(sent("Готово."));

    expect(mocks.appendWorkLine).not.toHaveBeenCalled();
  });
});
