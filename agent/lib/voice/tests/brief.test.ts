import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Calendar from "@agent/lib/google-workspace/calendar";
import type * as GoogleClient from "@agent/lib/google-workspace/client";

const mocks = vi.hoisted(() => ({
  account: vi.fn<() => Promise<{ id: string } | undefined>>(),
  calls:
    vi.fn<
      () => Promise<{ createdAt: Date; summary: string | null; task: string }[]>
    >(),
  events: vi.fn<() => Promise<{ items: object[] }>>(),
  jobs: vi.fn<
    () => Promise<{ nextRunAt: Date | null; prompt: string; status: string }[]>
  >(),
  memories: vi.fn<
    () => Promise<
      {
        content: { category: string; localOnly: boolean; text: string };
      }[]
    >
  >(),
  workstreams:
    vi.fn<
      () => Promise<
        { content: { nextStep: string; status: string; title: string } }[]
      >
    >(),
}));

vi.mock("@db/services/memory/records", () => ({
  listCurrentMemories: mocks.memories,
  readCabinetMemoryScopeKey: async () => await Promise.resolve("scope"),
}));
vi.mock("@db/services/phone", () => ({ readRecentCallRecords: mocks.calls }));
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  listScheduledAgentJobs: mocks.jobs,
}));
vi.mock("@db/services/workstreams", () => ({
  listWorkspaceWorkstreams: mocks.workstreams,
}));
vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => await Promise.resolve("full"),
}));
vi.mock("@shared/google-workspace/connection", () => ({
  googleWorkspaceAuthConfigId: () => "ac_google",
}));
vi.mock("@shared/composio/accounts", () => ({
  activeConnectedAccount: mocks.account,
}));
vi.mock("@agent/lib/google-workspace/client", async (importOriginal) => ({
  ...(await importOriginal<typeof GoogleClient>()),
  googleClient: () => ({ json: mocks.events }),
}));
vi.mock("@agent/lib/google-workspace/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof Calendar>()),
}));

const { voiceBrief, voiceCalendar } = await import("@agent/lib/voice/brief");

const scope = { userId: "u1", workspaceId: "w1" };
const now = new Date("2026-10-27T15:00:00Z");
const at = { now, timeZone: "Europe/Moscow" };
const memory = (
  text: string,
  extra: { category?: string; localOnly?: boolean } = {}
) => ({ content: { category: "fact", localOnly: false, text, ...extra } });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.memories.mockResolvedValue([]);
  mocks.jobs.mockResolvedValue([]);
  mocks.workstreams.mockResolvedValue([]);
  mocks.calls.mockResolvedValue([]);
});

describe("the brief the voice gets of its person", () => {
  it("carries what Bro keeps of them, but nothing kept from outside services and no code", async () => {
    mocks.memories.mockResolvedValue([
      memory("Брата зовут Лёша", { category: "person" }),
      memory("Не ест свинину", { category: "preference" }),
      memory("Без моего ок ничего не оплачивай", { category: "rule" }),
      memory("Диагноз только для себя", { localOnly: true }),
      memory("Код домофона 4512#"),
    ]);
    mocks.jobs.mockResolvedValue([
      {
        nextRunAt: new Date("2026-10-28T06:00:00Z"),
        prompt: "Пришли погоду на день",
        status: "active",
      },
      { nextRunAt: null, prompt: "Старое", status: "paused" },
    ]);
    mocks.workstreams.mockResolvedValue([
      {
        content: {
          nextStep: "ждём ответа клуба",
          status: "waiting",
          title: "Бронь в клубе",
        },
      },
      { content: { nextStep: "", status: "completed", title: "Билеты" } },
    ]);
    mocks.calls.mockResolvedValue([
      {
        createdAt: new Date("2026-10-27T14:00:00Z"),
        summary: `${"Бро: да. ".repeat(100)}Собеседник: Договорились на 20:30.`,
        task: "Забронировать стол",
      },
    ]);

    const brief = await voiceBrief(scope, at);

    for (const kept of [
      "Брата зовут Лёша",
      "Не ест свинину",
      "Без моего ок ничего не оплачивай",
      "ср 28.10 09:00: Пришли погоду на день",
      "«Бронь в клубе» (ждёт); дальше: ждём ответа клуба",
      "Договорились на 20:30",
    ])
      expect(brief).toContain(kept);
    for (const left of ["Диагноз", "4512", "Старое", "Билеты"])
      expect(brief).not.toContain(left);
  });

  it("is empty when nothing could be read", async () => {
    mocks.memories.mockRejectedValue(new Error("db down"));
    await expect(voiceBrief(scope, at)).resolves.toBe("");
  });
});

describe("the calendar the voice gets", () => {
  it("lists the week's events in the person's clock, without cancelled ones", async () => {
    mocks.account.mockResolvedValue({ id: "ca_1" });
    mocks.events.mockResolvedValue({
      items: [
        {
          end: { dateTime: "2026-10-28T15:30:00Z" },
          location: "Тверская, 1",
          start: { dateTime: "2026-10-28T15:00:00Z" },
          summary: "Стоматолог",
        },
        { start: { date: "2026-10-30" }, summary: "Отпуск" },
        {
          start: { dateTime: "2026-10-29T10:00:00Z" },
          status: "cancelled",
          summary: "Отменено",
        },
      ],
    });

    const calendar = await voiceCalendar(scope, at);

    expect(calendar).toContain(
      "ср 28.10 18:00–18:30 «Стоматолог», Тверская, 1"
    );
    expect(calendar).toContain("2026-10-30, весь день: «Отпуск»");
    expect(calendar).not.toContain("Отменено");
  });

  it("is undefined without a Google account or when Google fails", async () => {
    mocks.account.mockResolvedValue(undefined);
    await expect(voiceCalendar(scope, at)).resolves.toBeUndefined();
    mocks.account.mockResolvedValue({ id: "ca_1" });
    mocks.events.mockRejectedValue(new Error("Google down"));
    await expect(voiceCalendar(scope, at)).resolves.toBeUndefined();
  });
});
