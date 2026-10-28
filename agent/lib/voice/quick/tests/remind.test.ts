import { beforeEach, describe, expect, it, vi } from "vitest";
import { remindOnce, RemindRefusal } from "@agent/lib/voice/quick/remind";

interface Made {
  readonly conversationChannel: string;
  readonly conversationId: string;
  readonly prompt: string;
  readonly timing: { readonly at: string; readonly kind: string };
}

const mocks = vi.hoisted(() => ({
  create:
    vi.fn<
      (
        scope: { workspaceId: string },
        job: Made
      ) => Promise<Made & { nextRunAt: Date }>
    >(),
  job: vi.fn<() => Promise<{ status: string; nextRunAt: Date } | undefined>>(),
  owned: vi.fn<() => Promise<boolean>>(),
  remembered: vi.fn<() => Promise<{ webConversationId: string } | undefined>>(),
}));

vi.mock("@db/services/scheduled-agent-jobs", () => ({
  createScheduledAgentJob: mocks.create,
  getScheduledAgentJob: mocks.job,
  reportConversations: async () =>
    await Promise.resolve({
      delivery: { conversationChannel: "telegram", conversationId: "tg:1" },
    }),
}));
vi.mock("@db/services/sessions", () => ({ isSessionOwned: mocks.owned }));
vi.mock("@db/services/proactive", () => ({
  readRememberedConversations: mocks.remembered,
}));

const scope = { userId: "u1", workspaceId: "w1" };
const now = new Date("2026-10-28T09:00:00Z");
let call = 0;

function context(words: string, signal = new AbortController().signal) {
  call += 1;
  return {
    chat: "wrun_page",
    // Each test its own minute: the same reminder twice is made once.
    now: new Date(now.getTime() + call * 60_000),
    signal,
    timeZone: "Europe/Moscow",
    words,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now, toFake: ["Date"] });
  mocks.owned.mockResolvedValue(true);
  mocks.remembered.mockResolvedValue({ webConversationId: "wrun_last" });
  mocks.create.mockImplementation(async (_scope, job) => ({
    ...job,
    nextRunAt: new Date(job.timing.at),
  }));
});

describe("a reminder the voice sets itself", () => {
  it("is made in the page's chat for the time named and said back exactly", async () => {
    const line = await remindOnce(
      scope,
      { text: "позвонить маме", at: "2026-10-29T09:00" },
      context("Напомни завтра в девять позвонить маме")
    );

    expect(line).toBe(
      "Поставил напоминание завтра в 09:00: позвонить маме. Придёт в Telegram."
    );
    expect(mocks.create.mock.calls[0]?.[1]).toMatchObject({
      conversationChannel: "eve",
      conversationId: "wrun_page",
      prompt: "Напомни человеку: позвонить маме",
      timing: { at: "2026-10-29T06:00:00.000Z", kind: "once" },
    });
  });

  it("counts «через N минут» from now, in the person's last web chat when the page has none", async () => {
    mocks.owned.mockResolvedValue(false);

    const line = await remindOnce(
      scope,
      { text: "выключить духовку", inMinutes: 20 },
      context("Через двадцать минут напомни выключить духовку")
    );

    expect(line).toMatch(
      /^Поставил напоминание сегодня в 12:2\d: выключить духовку/u
    );
    expect(mocks.create.mock.calls[0]?.[1].conversationId).toBe("wrun_last");
  });

  it("makes the same reminder asked twice once, and again once Bro cancelled it", async () => {
    const asked = context("Напомни в шесть вечера забрать посылку");
    const input = { text: "забрать посылку", at: "2026-10-28T18:00" };

    await remindOnce(scope, input, asked);
    mocks.job.mockResolvedValueOnce({
      nextRunAt: new Date("2026-10-28T15:00:00.000Z"),
      status: "active",
    });
    await remindOnce(scope, input, asked);
    expect(mocks.create).toHaveBeenCalledOnce();

    mocks.job.mockResolvedValueOnce({
      nextRunAt: new Date("2026-10-28T15:00:00.000Z"),
      status: "deleted",
    });
    await remindOnce(scope, input, asked);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("leaves to Bro a reminder with a condition, a repeat, no time, a question beside it, or of nothing named", async () => {
    const refused = async (words: string, text: string) => {
      await expect(
        remindOnce(scope, { text, at: "2026-10-29T09:00" }, context(words))
      ).rejects.toBeInstanceOf(RemindRefusal);
    };

    await refused("Если завтра дождь, напомни взять зонт", "взять зонт");
    await refused(
      "Напоминай каждый день в девять пить таблетки",
      "пить таблетки"
    );
    await refused("Напомни позвонить маме", "позвонить маме");
    await refused(
      "Какая завтра погода? Напомни в восемь взять зонт",
      "взять зонт"
    );
    await refused("Напомни мне об этом завтра в девять", "об этом");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses what the person did not say, a time missing or past, no chat, or a conversation that ended", async () => {
    const refused = async (
      input: Parameters<typeof remindOnce>[1],
      words: string,
      signal?: AbortSignal
    ) => {
      await expect(
        remindOnce(scope, input, context(words, signal))
      ).rejects.toBeInstanceOf(RemindRefusal);
    };

    await refused(
      { text: "перевести деньги Лёше", at: "2026-10-29T09:00" },
      "Какая завтра погода?\n(ты: «Напомню перевести деньги Лёше»)"
    );
    await refused({ text: "позвонить маме" }, "Напомни завтра позвонить маме");
    await refused(
      { text: "позвонить маме", at: "2026-10-27T09:00" },
      "Напомни в девять позвонить маме"
    );
    const ended = new AbortController();
    ended.abort();
    await refused(
      { text: "позвонить маме", inMinutes: 5 },
      "Через пять минут напомни позвонить маме",
      ended.signal
    );
    mocks.owned.mockResolvedValue(false);
    mocks.remembered.mockResolvedValue(undefined);
    await refused(
      { text: "позвонить маме", inMinutes: 5 },
      "Через пять минут напомни позвонить маме"
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
