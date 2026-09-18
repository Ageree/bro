import type { SessionAuth } from "eve/context";
import type { ToolContext } from "eve/tools";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { accessScopeForUser } from "@shared/identity/access-scope";

vi.mock("eve/context", () => ({
  defineState<T>(_name: string, initial: () => T) {
    let value = initial();
    return {
      get: () => value,
      update(update: (current: T) => T) {
        value = update(value);
      },
    };
  },
}));

import { resolveTelegramReplyTarget } from "@agent/lib/reply-targets";
import { scheduleOwner, scheduleReplyAnchor } from "@agent/lib/schedules/tools";
import {
  telegramChatIdFromConversationId,
  telegramConversationIdSchema,
} from "@agent/lib/telegram-conversation";
import { scheduledAgentJobs } from "@db/schema";

describe("Telegram conversation identity", () => {
  it("accepts eve's private-chat continuation token", () => {
    expect(telegramConversationIdSchema.safeParse("4242::").success).toBe(true);
    expect(telegramConversationIdSchema.safeParse("-100123:7:55").success).toBe(
      true
    );
    expect(
      telegramConversationIdSchema.safeParse("imessage:dm:chat-1").success
    ).toBe(false);
    expect(telegramChatIdFromConversationId("4242::")).toBe("4242");
    expect(telegramChatIdFromConversationId("nope")).toBeUndefined();
  });

  it("owns a schedule created from a Telegram chat", () => {
    expect(scheduleOwner(telegramToolContext())).toEqual({
      conversation: {
        conversationChannel: "telegram",
        conversationId: "4242::",
      },
      scope: telegramScope,
    });
    expect(scheduleReplyAnchor(telegramToolContext())).toBe("77");
  });

  it("stores telegram alongside the existing conversation channels", () => {
    const table = getTableConfig(scheduledAgentJobs);
    const conversationChannel = table.columns.find(
      (column) => column.name === "conversation_channel"
    );

    expect(conversationChannel?.enumValues).toEqual([
      "eve",
      "photon",
      "telegram",
    ]);
    expect(
      table.checks.find(
        (check) =>
          check.name === "scheduled_agent_jobs_conversation_channel_check"
      )
    ).toBeDefined();
  });

  it("resolves the current Telegram message as a reply target", () => {
    expect(
      resolveTelegramReplyTarget({ kind: "current" }, telegramAuth())
    ).toEqual({ conversationId: "4242::", messageId: "77" });
  });

  it("resolves the automation handle a Telegram report supplies", () => {
    expect(
      resolveTelegramReplyTarget(
        { id: "00000000-0000-4000-8000-000000000003", kind: "automation" },
        telegramReportAuth()
      )
    ).toEqual({ conversationId: "4242::", messageId: "77" });
  });
});

const telegramScope = accessScopeForUser("better-auth:user-1");

function telegramAuth(): SessionAuth {
  return {
    current: {
      attributes: {
        conversationChannel: "telegram",
        conversationId: "4242::",
        telegramChatId: "4242",
        telegramMessageId: "77",
        workspaceId: telegramScope.workspaceId,
      },
      authenticator: "telegram-webhook",
      principalId: "better-auth:user-1",
      principalType: "user",
    },
    initiator: null,
  };
}

function telegramReportAuth(): SessionAuth {
  return {
    current: {
      attributes: {
        conversationChannel: "telegram",
        conversationId: "4242::",
        scheduleId: "00000000-0000-4000-8000-000000000003",
        scheduledReportLeaseToken: "00000000-0000-4000-8000-000000000004",
        scheduledReportSequence: "1",
        scheduledRunId: "00000000-0000-4000-8000-000000000002",
        telegramReplyAnchorMessageId: "77",
        workspaceId: telegramScope.workspaceId,
      },
      authenticator: "scheduled-result",
      principalId: "better-auth:user-1",
      principalType: "user",
    },
    initiator: null,
  };
}

function telegramToolContext() {
  return toolContext({
    session: { auth: telegramAuth(), id: "session-1" },
  });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This test adapter deliberately accepts a focused structural fixture.
function toolContext(value: unknown): ToolContext {
  // SAFETY: These schedule helpers read only the session auth and id.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete tool context would add unrelated runtime handles.
  return value as ToolContext;
}
