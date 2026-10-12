import { afterEach, describe, expect, it, vi } from "vitest";

const take = vi.fn<
  () => Promise<
    {
      conversationChannel: "eve" | "photon" | "telegram";
      conversationId: string;
      id: string;
      site: string | null;
      task: string;
    }[]
  >
>();
const markSent = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("@db/services/browser-runs", () => ({
  markBrowserRunNoticeSent: markSent,
  takeAbandonedBrowserRunReports: take,
}));
vi.mock("@shared/environment", () => ({
  env: { TELEGRAM_BOT_TOKEN: "token" },
}));

afterEach(() => {
  vi.restoreAllMocks();
  take.mockReset();
  markSent.mockReset();
});

describe("abandoned browser run report notice", () => {
  it("names the errand by its site and tells the person how to get the result", async () => {
    const { abandonedReportNotice } =
      await import("@agent/lib/browser-use/abandoned-notice");
    expect(
      abandonedReportNotice({ site: "https://www.ozon.ru/cart", task: "x" })
    ).toBe(
      "Поручение «ozon.ru» закончено, но итог не дошёл. Спросите меня «что там с ozon.ru», и я расскажу."
    );
  });

  it("sends each taken run's notice directly, and records only the ones that landed", async () => {
    take.mockResolvedValue([
      {
        conversationChannel: "telegram",
        conversationId: "42::",
        id: "run-1",
        site: null,
        task: "Найди билеты",
      },
      {
        conversationChannel: "telegram",
        conversationId: "43::",
        id: "run-2",
        site: null,
        task: "Закажи еду",
      },
    ]);
    const sent: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      sent.push({ body: await request.json(), url: request.url });
      // The second chat refuses: its person has not been told.
      return sent.length === 1
        ? Response.json({ ok: true })
        : Response.json({ ok: false }, { status: 403 });
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { abandonedReportNotice, noticeAbandonedBrowserRunReports } =
      await import("@agent/lib/browser-use/abandoned-notice");

    await noticeAbandonedBrowserRunReports(new Date());

    expect(sent).toEqual([
      {
        body: {
          chat_id: "42",
          text: abandonedReportNotice({ site: null, task: "Найди билеты" }),
        },
        url: "https://api.telegram.org/bottoken/sendMessage",
      },
      {
        body: {
          chat_id: "43",
          text: abandonedReportNotice({ site: null, task: "Закажи еду" }),
        },
        url: "https://api.telegram.org/bottoken/sendMessage",
      },
    ]);
    expect(markSent.mock.calls.map(([id]) => id)).toEqual(["run-1"]);
  });
});
