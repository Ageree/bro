import { afterEach, describe, expect, it, vi } from "vitest";

const take = vi.fn();
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
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { noticeAbandonedBrowserRunReports } =
      await import("@agent/lib/browser-use/abandoned-notice");

    await noticeAbandonedBrowserRunReports(new Date());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.telegram.org/bottoken/sendMessage");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      chat_id: "42",
      text: expect.stringContaining("Найди билеты"),
    });
  });
});
