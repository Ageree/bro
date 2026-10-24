import type { AttachSessionFn } from "eve/channels";
import type { ScheduleToFn } from "eve/schedules";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Reports from "@db/services/bro-to-bro/reports";

type ClaimedReport = Awaited<
  ReturnType<typeof Reports.claimBroReports>
>[number];

const outbox = vi.hoisted(() => ({
  claimBroReports: vi.fn<() => Promise<ClaimedReport[]>>(),
  finishBroReport: vi.fn<typeof Reports.finishBroReport>(),
  remembered: vi.fn<
    () => Promise<
      | {
          messengerChannel: "photon" | "telegram" | null;
          messengerConversationId: string | null;
          webConversationId: string | null;
        }
      | undefined
    >
  >(),
}));

vi.mock("@db/services/bro-to-bro/reports", () => ({
  claimBroReports: outbox.claimBroReports,
  finishBroReport: outbox.finishBroReport,
}));
vi.mock("@db/services/proactive", () => ({
  readRememberedConversations: outbox.remembered,
  rememberedMessenger: (remembered: {
    messengerChannel: string | null;
    messengerConversationId: string | null;
  }) =>
    remembered.messengerChannel && remembered.messengerConversationId
      ? {
          conversationChannel: remembered.messengerChannel,
          conversationId: remembered.messengerConversationId,
        }
      : undefined,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: async () => "Europe/Moscow",
}));
vi.mock("@agent/channels/photon", () => ({ default: { name: "photon" } }));
vi.mock("@agent/channels/telegram", () => ({ default: { name: "telegram" } }));

import photon from "@agent/channels/photon";
import telegram from "@agent/channels/telegram";
import { deliverBroReports } from "@agent/lib/bro-to-bro/report";

const reportId = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";

function report(target: ClaimedReport["target"]): ClaimedReport {
  return {
    attempts: 1,
    createdAt: new Date("2026-10-23T12:00:00Z"),
    id: reportId,
    kind: "question",
    leaseToken: token,
    payload: { peerLabel: null, peerName: "Пётр", questionId: "q", text: "?" },
    target,
    threadId,
    userId: "better-auth:savely",
    workspaceId: "personal:savely",
  };
}

type Send = (
  message: string,
  options: {
    readonly auth: {
      readonly attributes: Readonly<Record<string, string>>;
      readonly authenticator: string;
    };
    readonly turnPolicy: string;
  }
) => Promise<void>;

function deliver(send = vi.fn<Send>(async () => undefined)) {
  // SAFETY: the delivery only calls `send` on the handle.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A bare handle stands in for the channel's.
  const to = vi.fn<ScheduleToFn>(() => ({ send }) as never);
  const attachSession = vi.fn<AttachSessionFn>();
  return {
    attachSession,
    send,
    to,
    run: () => deliverBroReports({ attachSession, to }),
  };
}

describe("delivering Bro ↔ Bro reports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outbox.remembered.mockResolvedValue(undefined);
  });

  it("opens a queued turn of its own in the chat the errand was started from", async () => {
    outbox.claimBroReports.mockResolvedValue([
      report({
        conversationChannel: "telegram",
        conversationId: "4242::",
        sessionId: "session-1",
      }),
    ]);
    const delivery = deliver();
    await delivery.run();

    expect(delivery.to).toHaveBeenCalledExactlyOnceWith(telegram, {
      chatId: "4242",
    });
    const [message, options] = delivery.send.mock.calls[0] ?? [];
    expect(message).toContain(
      `bro_talk with action answer, thread ${threadId}`
    );
    expect(options).toMatchObject({
      auth: {
        attributes: {
          broReportId: reportId,
          broReportToken: token,
          broThreadId: threadId,
        },
        authenticator: "bro-result",
      },
      turnPolicy: "queue",
    });
    expect(outbox.finishBroReport).not.toHaveBeenCalled();
  });

  it("goes to the messenger the owner last wrote from, and is dropped without one", async () => {
    outbox.claimBroReports.mockResolvedValue([report(null)]);
    outbox.remembered.mockResolvedValueOnce({
      messengerChannel: "photon",
      messengerConversationId: "imessage:+79160000000",
      webConversationId: null,
    });
    const delivery = deliver();
    await delivery.run();
    expect(delivery.to).toHaveBeenCalledExactlyOnceWith(photon, {
      adapterName: "imessage",
      threadId: "imessage:+79160000000",
    });

    await delivery.run();
    expect(delivery.send).toHaveBeenCalledOnce();
    expect(outbox.finishBroReport).toHaveBeenCalledExactlyOnceWith(
      reportId,
      token,
      { delivered: false, error: "no chat", retry: false }
    );
  });

  it("goes to the web chat an owner with no messenger last wrote in", async () => {
    outbox.claimBroReports.mockResolvedValue([report(null)]);
    outbox.remembered.mockResolvedValueOnce({
      messengerChannel: null,
      messengerConversationId: null,
      webConversationId: "web-session-1",
    });
    const send = vi.fn<
      (...call: Parameters<Send>) => Promise<{ readonly status: string }>
    >(async () => ({ status: "accepted" }));
    const delivery = deliver();
    delivery.attachSession.mockReturnValue(
      // SAFETY: the delivery only calls `send` on the handle.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A bare handle stands in for the session's.
      { send } as never
    );
    await delivery.run();

    expect(delivery.to).not.toHaveBeenCalled();
    expect(delivery.attachSession).toHaveBeenCalledExactlyOnceWith(
      "web-session-1"
    );
    const [message, options] = send.mock.calls[0] ?? [];
    expect(message).toContain(`thread ${threadId}`);
    expect(options).toMatchObject({
      auth: {
        attributes: {
          conversationChannel: "eve",
          conversationId: "web-session-1",
        },
        authenticator: "bro-result",
      },
      turnPolicy: "queue",
    });
    expect(outbox.finishBroReport).not.toHaveBeenCalled();
  });

  it("puts a report whose dispatch failed back in line", async () => {
    outbox.claimBroReports.mockResolvedValue([
      report({
        conversationChannel: "telegram",
        conversationId: "4242::",
        sessionId: "session-1",
      }),
    ]);
    await deliver(
      vi.fn<Send>(async () => {
        throw new Error("channel down");
      })
    ).run();

    expect(outbox.finishBroReport).toHaveBeenCalledExactlyOnceWith(
      reportId,
      token,
      { delivered: false, error: "dispatch failed", retry: true }
    );
  });
});
