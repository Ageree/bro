import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Ai from "ai";
import { askBro, speakableAnswer } from "@agent/lib/phone/ask";
import { outboundPrompt } from "@shared/phone/persona";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn<
    (options: { prompt: string }) => Promise<{
      output: { answer: string | null; source: string };
    }>
  >(),
  memories:
    vi.fn<
      () => Promise<
        { content: { text: string; category: string; localOnly: boolean } }[]
      >
    >(),
  calls: vi.fn<
    () => Promise<
      {
        direction: string;
        target: string;
        state: string;
        summary: string;
      }[]
    >
  >(),
  profile: vi.fn<() => Promise<Record<string, string>>>(),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof Ai>()),
  generateText: mocks.generateText,
}));
vi.mock("@agent/lib/model/direct", () => ({
  directModelSelection: vi.fn<() => undefined>(),
}));
vi.mock("@shared/model/provider", () => ({ directModelActive: () => false }));
vi.mock("@db/services/settings", () => ({
  getWorkspaceModelId: () => Promise.resolve("test/model"),
}));
vi.mock("@db/services/user-profile", () => ({
  readUserProfile: mocks.profile,
}));
vi.mock("@db/services/phone", () => ({ listPhoneCalls: mocks.calls }));
vi.mock("@db/services/memory/records", () => ({
  readCabinetMemoryScopeKey: () => Promise.resolve("scope"),
  listCurrentMemories: mocks.memories,
}));

const scope = { userId: "u1", workspaceId: "w1" };
const publicNumber = "+79249098921";
const question = {
  scope,
  task: "Забронировать столик на вечер",
  target: "+78005553535",
  publicNumber,
  heard: "Собеседник: На какую фамилию записать?",
};
const memory = (
  text: string,
  extra: { category?: string; localOnly?: boolean } = {}
) => ({
  content: { text, category: "fact", localOnly: false, ...extra },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.profile.mockResolvedValue({
    firstName: "Максим",
    lastName: "Иванов",
    city: "Казань",
    phone: "+79990001122",
    email: "me@example.com",
    dateOfBirth: "1990-01-01",
    addressLine1: "ул. Пушкина, 1",
  });
  mocks.memories.mockResolvedValue([]);
  mocks.calls.mockResolvedValue([]);
});

describe("the line the voice may say", () => {
  const says = (
    answer: string | null,
    source: "profile" | "none" = "profile"
  ) => speakableAnswer({ answer, source }, publicNumber);

  it("passes a short plain answer", () => {
    expect(says("Запишите на Иванова.")).toBe("Запишите на Иванова.");
  });

  it("drops no answer, an unsourced one and a long one", () => {
    expect(says(null)).toBeNull();
    expect(says("Иванов", "none")).toBeNull();
    expect(says("а".repeat(241))).toBeNull();
  });

  it.each([
    ["a card number", "Карта 4276 3800 1234 5678"],
    ["a passport", "Паспорт 4510 123456"],
    ["a code", "Код из смс 482193"],
    ["an address of mail", "Пишите на me@example.com"],
    ["a telephone of someone", "Звоните +7 999 000-11-22"],
    ["a telephone with brackets", "Номер мамы +7 (916) 123-45-67"],
    ["a city number", "Звоните 495 123-45-67"],
    [
      "a telephone in words",
      "Восемь девятьсот девяносто девять ноль ноль один",
    ],
    ["a door code", "Код подъезда 4512"],
  ])("drops %s", (_, answer) => {
    expect(says(answer)).toBeNull();
  });

  it("lets Bro's public number, times, dates and years through", () => {
    expect(says("Перезвоните на +7 924 909 89 21")).not.toBeNull();
    expect(says("Перезвоните на +79249098921")).not.toBeNull();
    expect(says("27.10.2026 в 19:00, два места")).not.toBeNull();
    expect(says("Мы были у вас в 2025 году")).not.toBeNull();
  });
});

describe("the question put to Bro", () => {
  it("sends the model only what a stranger may hear, and says its answer", async () => {
    mocks.memories.mockResolvedValue([
      memory("Не ем свинину"),
      memory("Только у себя", { localOnly: true }),
      memory("Не называй мою фамилию по телефону", { category: "rule" }),
      memory("У мамы диабет", { category: "person" }),
      memory("Код домофона 4512, кв. 37"),
      memory("пароль от почты — Kot2024!"),
    ]);
    mocks.calls.mockResolvedValue([
      {
        direction: "outbound",
        target: question.target,
        state: "done",
        summary: `Call transcript (task success is for you to judge from it):\n${"Бро: привет. ".repeat(80)}Договорились на 19:00`,
      },
      {
        direction: "outbound",
        target: question.target,
        state: "done",
        summary: "The call connected, but nothing was heard or said.",
      },
      {
        direction: "outbound",
        target: "+70000000000",
        state: "done",
        summary: "Чужой номер",
      },
    ]);
    mocks.generateText.mockResolvedValue({
      output: { answer: "На Иванова.", source: "profile" },
    });

    await expect(askBro(question)).resolves.toBe("На Иванова.");

    const sent = mocks.generateText.mock.calls[0]?.[0].prompt ?? "";
    expect(sent).toContain("Максим Иванов");
    expect(sent).toContain("Не ем свинину");
    expect(sent).toContain('"memories":["Не ем свинину"]');
    expect(sent).toContain("Договорились на 19:00");
    expect(sent).toContain(question.heard);
    expect(sent).toContain("Не называй мою фамилию по телефону");
    expect(sent).not.toContain("Call transcript");
    expect(sent).not.toContain("nothing was heard");
    for (const left of [
      "Только у себя",
      "диабет",
      "4512",
      "Kot2024",
      "Чужой номер",
      "+79990001122",
      "me@example.com",
      "1990-01-01",
      "Пушкина",
    ])
      expect(sent).not.toContain(left);
  });

  it("answers nothing when the model fails or says a secret", async () => {
    mocks.generateText.mockRejectedValueOnce(new Error("down"));
    await expect(askBro(question)).resolves.toBeNull();
    mocks.generateText.mockResolvedValueOnce({
      output: { answer: "Звоните на me@example.com", source: "profile" },
    });
    await expect(askBro(question)).resolves.toBeNull();
  });
});

describe("the call's prompt", () => {
  const base = {
    callRules: "правила",
    publicNumber,
    durationSeconds: 600,
    repeatCall: false,
    task: "задача",
  };

  it("keeps the no-tools line as it was unless the voice may ask", () => {
    expect(outboundPrompt(base)).toContain("У тебя нет инструментов: ни для");
    expect(outboundPrompt(base)).not.toContain("делегированием");
    expect(outboundPrompt({ ...base, canAsk: true })).toContain(
      "делегированием"
    );
  });
});
