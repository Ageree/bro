import type { AttachSessionFn, Session } from "eve/channels";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { takeAbandonedBrowserRunReports } from "@db/services/browser-runs";
import { backgroundNoticeMessage } from "@shared/chat/background-turn";

const take = vi.fn<typeof takeAbandonedBrowserRunReports>();
const markSent = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>());
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
      abandoned({
        conversationChannel: "telegram",
        conversationId: "42::",
        id: "run-1",
        task: "Найди билеты",
      }),
      abandoned({
        conversationChannel: "telegram",
        conversationId: "43::",
        id: "run-2",
        task: "Закажи еду",
      }),
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

    await noticeAbandonedBrowserRunReports({}, new Date());

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

  it("hands a web chat's notice to its session as a turn of its own, and records it once taken", async () => {
    take.mockResolvedValue([
      abandoned({
        conversationChannel: "eve",
        conversationId: "web-session-1",
        id: "run-1",
        site: "https://www.ozon.ru/cart",
      }),
      abandoned({
        conversationChannel: "eve",
        conversationId: "web-session-2",
        id: "run-2",
        task: "Закажи еду",
      }),
    ]);
    const send = vi
      .fn<Session["send"]>()
      .mockResolvedValueOnce({ sessionId: "web-session-1", status: "accepted" })
      // The second chat is starting up: its person has not been told.
      .mockResolvedValueOnce({ retryable: true, status: "session_not_active" });
    const attachSession = vi.fn<AttachSessionFn>((id) => ({
      cancel: vi.fn<Session["cancel"]>(),
      clear: vi.fn<Session["clear"]>(),
      compact: vi.fn<Session["compact"]>(),
      getEventStream: vi.fn<Session["getEventStream"]>(),
      getStreamTailIndex: vi.fn<Session["getStreamTailIndex"]>(),
      id,
      reset: vi.fn<Session["reset"]>(),
      respond: vi.fn<Session["respond"]>(),
      send,
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { abandonedReportNotice, noticeAbandonedBrowserRunReports } =
      await import("@agent/lib/browser-use/abandoned-notice");

    await noticeAbandonedBrowserRunReports({ attachSession }, new Date());

    expect(attachSession.mock.calls.map(([id]) => id)).toEqual([
      "web-session-1",
      "web-session-2",
    ]);
    expect(send.mock.calls[0]).toEqual([
      backgroundNoticeMessage(
        abandonedReportNotice({ site: "https://www.ozon.ru/cart", task: "x" })
      ),
      {
        auth: {
          attributes: {
            browserRunId: "run-1",
            conversationChannel: "eve",
            conversationId: "web-session-1",
            workspaceId: "workspace-1",
          },
          authenticator: "browser-notice",
          issuer: "open-instinct",
          principalId: "user-1",
          principalType: "user",
        },
        turnPolicy: "queue",
      },
    ]);
    expect(markSent.mock.calls.map(([id]) => id)).toEqual(["run-1"]);
  });
});

function abandoned(
  run: Partial<Awaited<ReturnType<typeof take>>[number]>
): Awaited<ReturnType<typeof take>>[number] {
  return {
    conversationChannel: "telegram",
    conversationId: "42::",
    createdByUserId: "user-1",
    id: "run-1",
    site: null,
    task: "Найди билеты",
    workspaceId: "workspace-1",
    ...run,
  };
}
