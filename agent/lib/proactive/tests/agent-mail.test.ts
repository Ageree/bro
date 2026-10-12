import { afterEach, describe, expect, it, vi } from "vitest";
import type { listAgentMessages } from "@agent/lib/agent-mail/client";
import { agentMailCheck } from "@agent/lib/proactive/agent-mail";

// Only the fields the check reads of a mailbox row are faked.
const mail = vi.hoisted(() => ({
  enabled: vi.fn<() => boolean>(() => true),
  list: vi.fn<typeof listAgentMessages>(),
  mailbox: vi.fn<() => Promise<{ inboxId: string } | undefined>>(() =>
    Promise.resolve({ inboxId: "inbox-bro" })
  ),
}));

vi.mock("@agent/lib/agent-mail/client", () => ({
  listAgentMessages: mail.list,
}));
vi.mock("@db/services/agent-mail", () => ({
  agentMailboxEnabled: mail.enabled,
}));
vi.mock("@db/services/agent-mailboxes", () => ({
  readAgentMailbox: mail.mailbox,
}));

const scope = { userId: "better-auth:alice", workspaceId: "workspace:alice" };
const now = new Date("2026-09-23T12:00:00.000Z");
const watermark = new Date("2026-09-23T11:40:00.000Z");

function message(id: string, timestamp: string, labels = ["received"]) {
  return {
    from: "Анна <anna@example.com>",
    inbox_id: "inbox-bro",
    labels,
    message_id: id,
    thread_id: `thread-${id}`,
    timestamp,
    to: ["bro@example.test"],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  mail.enabled.mockReturnValue(true);
  mail.mailbox.mockResolvedValue({ inboxId: "inbox-bro" });
  mail.list.mockReset();
});

describe("the agency pilot's agent inbox check", () => {
  it("has nothing to read in a workspace without a mailbox", async () => {
    mail.mailbox.mockResolvedValue(undefined);

    expect(await agentMailCheck(scope, watermark, now)).toBeUndefined();
    expect(mail.list).not.toHaveBeenCalled();
  });

  it("reads nothing while agent mail is switched off for the workspace", async () => {
    mail.enabled.mockReturnValue(false);

    expect(await agentMailCheck(scope, watermark, now)).toBeUndefined();
    expect(mail.list).not.toHaveBeenCalled();
  });

  it("starts the watermark at the first check and hands over no mail that came before it", async () => {
    expect(await agentMailCheck(scope, null, now)).toEqual({
      checkedAt: now,
      signals: [],
    });
    expect(mail.list).not.toHaveBeenCalled();
  });

  it("hands over mail since the watermark, by message id, and moves the watermark to now", async () => {
    mail.list.mockResolvedValue({
      count: 3,
      messages: [
        message("new", "2026-09-23T11:55:00.000Z"),
        message("earlier", "2026-09-23T11:20:00.000Z"),
        message("sent", "2026-09-23T11:58:00.000Z", ["sent"]),
      ],
    });

    expect(await agentMailCheck(scope, watermark, now)).toEqual({
      checkedAt: now,
      signals: [
        {
          dedupeKey: "new",
          itemId: "new",
          source: "agent_mail",
          threadId: "thread-new",
        },
      ],
    });
    // One page, the newest messages only; the window reaches back ten
    // minutes before the watermark, where a late message may land.
    expect(mail.list).toHaveBeenCalledExactlyOnceWith(scope, { limit: 50 });
  });

  it("leaves the watermark where it was when the provider cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mail.list.mockRejectedValue(new Error("AgentMail request failed (503)."));

    expect(await agentMailCheck(scope, watermark, now)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[proactive] agent mail check failed", {
      error: "Error",
    });
  });
});
