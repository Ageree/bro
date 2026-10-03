import type { HookContext } from "eve/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { appendConversationLine } from "@db/services/conversation-log";
import type conversationLogHook from "@agent/hooks/conversation-log";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { accessScopeForUser } from "@shared/identity/access-scope";

const mocks = vi.hoisted(() => ({
  appendConversationLine: vi.fn<typeof appendConversationLine>(),
}));

vi.mock("@db/services/conversation-log", () => ({
  appendConversationLine: mocks.appendConversationLine,
  conversationLineLimit: 500,
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

function context(
  options: { readonly caller?: Caller; readonly channel?: string } = {}
) {
  const current = options.caller ?? caller();
  return {
    agent: { name: "test-agent" },
    channel: { kind: options.channel ?? "channel:telegram" },
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

/** A subagent's session, which inherits the person's caller. */
function subagentContext(): HookContext {
  const parent = context();
  return {
    ...parent,
    session: {
      ...parent.session,
      parent: {
        callId: "call-0",
        rootSessionId: "session-0",
        sessionId: "session-0",
        turn: { id: "turn_0", sequence: 0 },
      },
    },
  };
}

type HookEvents = NonNullable<(typeof conversationLogHook)["events"]>;
type ReceivedEvent = Parameters<NonNullable<HookEvents["message.received"]>>[0];

const meta = { at: "2026-10-03T07:00:00.000Z", id: "event-1" };

function received(
  message: string,
  kind?: "execution.background_task"
): ReceivedEvent {
  return {
    data: { kind, message, sequence: 1, turnId: "turn_1" },
    meta,
    type: "message.received",
  };
}

async function loadHook(list: string) {
  vi.resetModules();
  vi.stubEnv("CROSS_CHANNEL_WORKSPACES", list);
  const hook = (await import("@agent/hooks/conversation-log")).default;
  const onReceived = hook.events?.["message.received"];
  if (!onReceived) throw new Error("The hook must listen.");
  return {
    events: Object.keys(hook.events ?? {}),
    received: async (event: ReceivedEvent, ctx: HookContext = context()) =>
      onReceived(event, ctx),
  };
}

/** A long paste with a four-digit number every 12 characters. */
function longMessage(size: number) {
  return Array.from(
    { length: size / 12 },
    (_, index) => `${String(1000 + (index % 9000))} заказ, `
  ).join("");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.appendConversationLine.mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv("CROSS_CHANNEL_WORKSPACES", "");
});

describe("the conversation log hook", () => {
  it("logs nothing outside the pilot", async () => {
    const hook = await loadHook("");
    await hook.received(received("Напомни про Казань"));

    expect(mocks.appendConversationLine).not.toHaveBeenCalled();
  });

  it("logs the person's message with its turn, and nothing Bro says", async () => {
    const hook = await loadHook("*");
    await hook.received(received("Напомни про Казань"));
    await hook.received(
      received("Как там билеты?"),
      context({ caller: caller("authjs"), channel: "channel:eve" })
    );

    expect(mocks.appendConversationLine.mock.calls).toEqual([
      [
        scope.workspaceId,
        {
          channel: "channel:telegram",
          createdAt: new Date(meta.at),
          sessionId: "session-1",
          text: "Напомни про Казань",
          turnId: "turn_1",
        },
      ],
      [
        scope.workspaceId,
        {
          channel: "channel:eve",
          createdAt: new Date(meta.at),
          sessionId: "session-1",
          text: "Как там билеты?",
          turnId: "turn_1",
        },
      ],
    ]);
    // Bro's messages quote mail, pages and task output, which another
    // chat's recap, user-role turn context, must not carry.
    expect(hook.events).toEqual(["message.received"]);
  });

  // Review of item 28: the log is a store of its own, and a recap carried
  // the code to another chat.
  it("cuts one-time codes and card numbers out of the line, as memory does", async () => {
    const hook = await loadHook("*");
    await hook.received(
      received(
        "Код из смс 739204, оплати картой 4276 1234 5678 9012 билеты в Казань"
      )
    );

    const text = mocks.appendConversationLine.mock.lastCall?.[1].text;
    expect(text).toBe(
      "Код из смс [удалено], оплати картой [удалено] билеты в Казань"
    );
    expect(text).not.toContain("739204");
    expect(text).not.toContain("9012");
  });

  // Review of item 28: memory's filter wants a word for the code, and in a
  // chat a code is passed on bare — the reply to «пришли код из SMS».
  it.each([
    ["482913", "[удалено]"],
    ["код пришёл 482913", "код пришёл [удалено]"],
    ["Вот: 48 29 13", "Вот: [удалено]"],
    ["карта 4276 1234 5678 9012, 12/27, 123", "карта [удалено]"],
  ])("cuts the code or the card out of «%s»", async (message, line) => {
    const hook = await loadHook("*");
    await hook.received(received(message));
    expect(mocks.appendConversationLine.mock.lastCall?.[1].text).toBe(line);
  });

  it("keeps a longer message's order and flight numbers", async () => {
    const hook = await loadHook("*");
    const message = "Проверь заказ 48213 и рейс SU 1234 на завтра в Казань";
    await hook.received(received(message));
    expect(mocks.appendConversationLine.mock.lastCall?.[1].text).toBe(message);
  });

  // Review of item 28: the ≤3-words threshold of a bare code.
  it("keeps a bare number in a message of more than three words", async () => {
    const hook = await loadHook("*");
    await hook.received(received("Возьми четыре билета в Казань, 4820"));
    expect(mocks.appendConversationLine.mock.lastCall?.[1].text).toBe(
      "Возьми четыре билета в Казань, 4820"
    );
    await hook.received(received("Возьми билеты, 4820"));
    expect(mocks.appendConversationLine.mock.lastCall?.[1].text).toBe(
      "Возьми билеты, [удалено]"
    );
  });

  // Review of item 28: memory's filter takes a password only after «:» or
  // with a digit in it, and knows no passport, SNILS or a card's CVV.
  it.each([
    ["логин ivan, пароль qwerty", "логин ivan, пароль [удалено]"],
    ["пароль qwerty", "пароль [удалено]"],
    [
      "Пароль поменяли, новый пароль tiger",
      "Пароль поменяли, новый пароль [удалено]",
    ],
    ["пароль от почты «Kot»", "пароль от почты «[удалено]»"],
    ["смени пароль на qwerty123", "смени пароль на [удалено]"],
    ["секретное слово банка Мурзик", "секретное слово банка [удалено]"],
    [
      "кодовое слово для Сбера — ромашка",
      "кодовое слово для Сбера — [удалено]",
    ],
    [
      "код с обратной стороны карты 123",
      "код с обратной стороны карты [удалено]",
    ],
    [
      "три цифры на обороте 123, срок 12/27",
      "три цифры на обороте [удалено], срок 12/27",
    ],
    ["CVV-код 123", "CVV-код [удалено]"],
    [
      "Мой паспорт 4510 123456, выдан в Казани",
      "Мой паспорт [удалено], выдан в Казани",
    ],
    [
      "запиши на приём: 4510 123456, Иванов Иван",
      "запиши на приём: [удалено], Иванов Иван",
    ],
    [
      "мой снилс 123-456-789 01 для записи к врачу",
      "мой снилс [удалено] для записи к врачу",
    ],
    ["СНИЛС для поликлиники 12345678901", "СНИЛС для поликлиники [удалено]"],
    // Review of the fixes: a password after a word about it, after an owner
    // with more words behind it, a CVV with its card named after the number,
    // a SNILS on the next line or in dotted groups.
    ["пароль поменял на qwerty", "пароль поменял на [удалено]"],
    ["пароль сменил на qwerty123", "пароль сменил на [удалено]"],
    ["пароль теперь qwerty", "пароль теперь [удалено]"],
    ["пароль мой qwerty", "пароль мой [удалено]"],
    ["пароль снова qwerty", "пароль снова [удалено]"],
    ["пароль тот же qwerty", "пароль тот же [удалено]"],
    ["пароль простой qwerty", "пароль простой [удалено]"],
    ["пароль будет qwerty", "пароль будет [удалено]"],
    ["пароль нужен qwerty", "пароль нужен [удалено]"],
    ["пароль такой qwerty", "пароль такой [удалено]"],
    ["пароль от wifi qwerty если что", "пароль от wifi [удалено] если что"],
    [
      "пароль от почты qwerty и логин ivan",
      "пароль от почты [удалено] и логин ivan",
    ],
    ["пароль от вайфая tiger запиши", "пароль от вайфая [удалено] запиши"],
    [
      "пароль от личного кабинета Tigr на сайте",
      "пароль от личного кабинета [удалено] на сайте",
    ],
    // After the owner every word left in the clause goes, not just the first.
    ["пароль от кабинета мтс kotik", "пароль от кабинета [удалено] [удалено]"],
    ["трёхзначный код 123 на обороте", "трёхзначный код [удалено] на обороте"],
    [
      "код 123 с обратной стороны карты",
      "код [удалено] с обратной стороны карты",
    ],
    [
      "вот мой СНИЛС:\n12345678901 для записи",
      "вот мой СНИЛС:\n[удалено] для записи",
    ],
    ["снилс 123.456.789 01 для поликлиники", "снилс [удалено] для поликлиники"],
  ])("cuts the secret out of «%s»", async (message, line) => {
    const hook = await loadHook("*");
    await hook.received(received(message));
    expect(mocks.appendConversationLine.mock.lastCall?.[1].text).toBe(line);
  });

  // The other side of the trade: a word about a password, a door's code, a
  // date, a time, an amount and a flight stay in the line.
  it.each([
    "пароль от wifi поменяли?",
    "какой пароль от wifi?",
    "пароль не подходит, проверь ещё раз",
    "Пароль от личного кабинета забыл, помоги восстановить",
    "код домофона 123, квартира 45",
    "код заказа 4521, доставка на карте",
    "пароль не помню, сбросим?",
    "Вылет 15.10 в 10:30, рейс SU 1234, бюджет 15000 руб",
    "Встреча 2026-10-15 в 18:00 у метро, возьми 4510 рублей",
    "Купи 3 билета на поезд 7412 до Казани на 15 октября 2026",
  ])("keeps «%s» as it is", async (message) => {
    const hook = await loadHook("*");
    await hook.received(received(message));
    expect(mocks.appendConversationLine.mock.lastCall?.[1].text).toBe(message);
  });

  // Review of item 28: the filters read the whole message before the line
  // was cut to 500 characters, and each number in `oneTimeCodeRanges`
  // looks back over the text before it — a 100 KB paste in the web chat
  // held the one eve process for most of a minute.
  it("reads no more of a long message than the line keeps", async () => {
    const hook = await loadHook("*");
    /** The best of three: a pause of the machine is no filter's time. */
    const timed = async (text: string) => {
      const times: number[] = [];
      for (const _ of [0, 1, 2]) {
        const started = performance.now();
        // oxlint-disable-next-line eslint/no-await-in-loop -- one timing at a time
        await hook.received(received(text));
        times.push(performance.now() - started);
      }
      return Math.min(...times);
    };
    const smallMs = await timed(longMessage(16 * 1024));
    const largeMs = await timed(longMessage(128 * 1024));
    // Linear is about 8x and quadratic about 64x; under 50 ms the ratio is
    // only noise (`agent/lib/subscriptions/tests/price.test.ts`).
    expect(largeMs < 50 || largeMs < 24 * Math.max(smallMs, 20)).toBe(true);
    expect(largeMs).toBeLessThan(2_000);

    const line = mocks.appendConversationLine.mock.lastCall?.[1].text ?? "";
    expect(Array.from(line).length).toBeLessThanOrEqual(500);
  });

  // A secret that crosses the cut goes whole, and nothing past the cut
  // comes in, however much the placeholders saved before it.
  it("cuts a secret that crosses the 500th character, and keeps nothing past it", async () => {
    const hook = await loadHook("*");
    const lead = "а".repeat(490);
    await hook.received(received(`${lead} карта 4276 1234 5678 9012 конец`));
    expect(mocks.appendConversationLine.mock.lastCall?.[1].text).toBe(
      `${lead} карта [удалено]`
    );

    const cards = "карта 4276 1234 5678 9012, ".repeat(19);
    const tail = "б".repeat(80);
    await hook.received(received(`${cards}${tail}`));
    const text = mocks.appendConversationLine.mock.lastCall?.[1].text ?? "";
    expect(text).not.toContain("б");
    expect(text).not.toMatch(/\d/u);
  });

  it("logs no turn Bro opened and no background text", async () => {
    const hook = await loadHook("*");
    await hook.received(received(`${backgroundTurnMarker}\nОтчёт`));
    await hook.received(received("Итог задачи", "execution.background_task"));
    await hook.received(
      received("Browser run run-1 finished."),
      context({ caller: caller("browser-result") })
    );
    await hook.received(
      received("Проверь почту"),
      context({ caller: caller("scheduled-worker") })
    );
    await hook.received(received("Привет"), subagentContext());
    await hook.received(received("Привет"), context({ channel: "http" }));

    expect(mocks.appendConversationLine).not.toHaveBeenCalled();
  });

  // A message the person sends while a browser report's turn runs steers
  // into it: eve gives the step its own caller (`AuthKey` in
  // `harness/tool-loop.js`) before `message.received`, while the turn's
  // initiator stays the report's. The person's words are logged, the
  // report's never.
  it("logs the person's message that steered into a browser report's turn", async () => {
    const hook = await loadHook("*");
    const report = caller("browser-result");
    const steered = context();
    await hook.received(received("Browser run run-1 finished."), {
      ...steered,
      session: {
        ...steered.session,
        auth: { current: report, initiator: report },
      },
    });
    await hook.received(received("Бери второй вариант"), {
      ...steered,
      session: {
        ...steered.session,
        auth: { current: caller(), initiator: report },
      },
    });

    expect(
      mocks.appendConversationLine.mock.calls.map(([, line]) => line.text)
    ).toEqual(["Бери второй вариант"]);
  });

  it("never fails the turn, nor logs the line it lost", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.appendConversationLine.mockRejectedValue(
      new Error("Failed query: params: Напомни про Казань")
    );
    const hook = await loadHook("*");

    await expect(
      hook.received(received("Напомни про Казань"))
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Казань");
  });
});
