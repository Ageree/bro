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
vi.mock("@db/services/browser-runs", () => ({
  takeAbandonedBrowserRunReports: take,
}));
vi.mock("@shared/environment", () => ({
  env: { TELEGRAM_BOT_TOKEN: "token" },
}));

afterEach(() => {
  vi.restoreAllMocks();
  take.mockReset();
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

  it("sends each taken run's notice to its Telegram chat directly", async () => {
    take.mockResolvedValue([
      {
        conversationChannel: "telegram",
        conversationId: "42::",
        id: "run-1",
        site: null,
        task: "Найди билеты",
      },
      {
        conversationChannel: "eve",
        conversationId: "session-1",
        id: "run-2",
        site: null,
        task: "web chat",
      },
    ]);
    const sent: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      sent.push({ body: await request.json(), url: request.url });
      return Response.json({ ok: true });
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
    ]);
  });
});
