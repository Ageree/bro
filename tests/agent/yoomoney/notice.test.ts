import type { AttachSessionFn, Session } from "eve/channels";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { yoomoneyPayments } from "@db/schema/yoomoney";
import type * as stored from "@db/services/yoomoney/payments";
import { z } from "zod";
import {
  backgroundNoticeMessage,
  backgroundNoticeText,
} from "@shared/chat/background-turn";

const claim = vi.hoisted(() =>
  vi.fn<typeof stored.claimYoomoneyOutcomeNotices>()
);
const release = vi.hoisted(() =>
  vi.fn<typeof stored.releaseYoomoneyOutcomeNotice>()
);
vi.mock("@db/services/yoomoney/payments", () => ({
  claimYoomoneyOutcomeNotices: claim,
  releaseYoomoneyOutcomeNotice: release,
}));
vi.mock("@shared/environment", () => ({
  env: { TELEGRAM_BOT_TOKEN: "token" },
}));

afterEach(() => {
  vi.restoreAllMocks();
  claim.mockReset();
  release.mockReset();
});

function settled(
  overrides: Partial<typeof yoomoneyPayments.$inferSelect>
): typeof yoomoneyPayments.$inferSelect {
  return {
    id: "payment-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    rootSessionId: "session-1",
    kind: "service",
    account: "4100111222333",
    title: "МегаФон (Россия)",
    requestParams: { pattern_id: "337" },
    shown: [{ label: "Телефон", value: "9261234567" }],
    requestId: "request-1",
    amountMinor: 10_000,
    test: false,
    cardId: "card-1",
    cardLabel: "••4310",
    cscRequired: true,
    bankUri: null,
    bankParams: null,
    state: "paid",
    confirmationQuestion: "ЮMoney: МегаФон.",
    consentHash: "card-page",
    paymentId: "operation-1",
    error: null,
    callId: "card-page",
    conversationChannel: "telegram",
    conversationId: "42::",
    expiresAt: new Date(),
    createdAt: new Date(),
    submittedAt: new Date(),
    settledAt: new Date(),
    outcomeToldAt: new Date(),
    ...overrides,
  };
}

describe("the outcome of a wallet payment Bro did not see settle", () => {
  it("is told in the person's Telegram chat, and taken again when the chat refused it", async () => {
    claim.mockResolvedValue([
      settled({ id: "payment-1", conversationId: "42::" }),
      settled({ id: "payment-2", conversationId: "43::" }),
    ]);
    const sent: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      sent.push(await new Request(url, init).json());
      return sent.length === 1
        ? Response.json({ ok: true })
        : Response.json({ ok: false }, { status: 403 });
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { tellYoomoneyOutcomes } = await import("@agent/lib/yoomoney/notice");
    const now = new Date();

    await tellYoomoneyOutcomes({}, now);

    const messages = z
      .array(z.object({ chat_id: z.string(), text: z.string() }))
      .parse(sent);
    expect(messages.map((message) => message.chat_id)).toEqual(["42", "43"]);
    const text = messages[0]?.text ?? "";
    expect(text).toContain("Оплатил через ЮMoney");
    expect(text).toContain("100,00");
    expect(text).toContain("с карты ••4310");
    expect(release.mock.calls).toEqual([["payment-2", now]]);
  });

  it("comes to a web chat as a turn of its own that calls no model", async () => {
    claim.mockResolvedValue([
      settled({
        state: "refused",
        error: "not_in_history",
        conversationChannel: "eve",
        conversationId: "web-session-1",
      }),
    ]);
    const send = vi
      .fn<Session["send"]>()
      .mockResolvedValue({ sessionId: "web-session-1", status: "accepted" });
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
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { tellYoomoneyOutcomes } = await import("@agent/lib/yoomoney/notice");

    await tellYoomoneyOutcomes({ attachSession }, new Date());

    const text =
      backgroundNoticeText(z.string().parse(send.mock.calls[0]?.[0])) ?? "";
    expect(text).toContain("не прошёл");
    expect(text).toContain("Деньги не списаны");
    expect(attachSession).toHaveBeenCalledWith("web-session-1");
    expect(send).toHaveBeenCalledWith(backgroundNoticeMessage(text), {
      auth: {
        attributes: {
          yoomoneyPaymentId: "payment-1",
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
    });
    expect(release).not.toHaveBeenCalled();
  });
});
