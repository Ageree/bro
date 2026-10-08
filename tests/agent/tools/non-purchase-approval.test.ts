import type { Approval, ApprovalContext } from "eve/tools/approval";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { composioToolContext } from "@tests/helpers/composio";
import type { disconnectMail, readMailConnection } from "@db/services/mail";
import type { outboundRuleApproval } from "@agent/lib/memory/rule-approval";
import type {
  listAgentMessages,
  readAgentMessage,
  sendAgentMessage,
} from "@agent/lib/agent-mail/client";

const services = vi.hoisted(() => ({
  connection: vi.fn<typeof readMailConnection>(),
  rule: vi.fn<typeof outboundRuleApproval>(),
}));

vi.mock("@db/services/mail", () => ({
  disconnectMail: vi.fn<typeof disconnectMail>(),
  readMailConnection: services.connection,
}));
vi.mock("@shared/mail/providers", () => ({
  mailEnabled: () => true,
  mailProviderConfigured: () => true,
}));
vi.mock("@agent/lib/delivery/report-cards", () => ({
  reportCardHold: async () => undefined,
}));
vi.mock("@agent/lib/memory/rule-approval", () => ({
  outboundRuleApproval: services.rule,
}));
vi.mock("@agent/lib/agent-mail/client", () => ({
  ensureAgentMailbox: async () => ({ email: "bro@example.com" }),
  listAgentMessages: vi.fn<typeof listAgentMessages>(),
  readAgentMessage: vi.fn<typeof readAgentMessage>(),
  sendAgentMessage: vi.fn<typeof sendAgentMessage>(),
}));

import agentMail from "@agent/tools/agent_mail";
import { connectMail } from "@agent/tools/connect_mail";
import { mailSend, mailUpdate } from "@agent/tools/mail";

async function decide<T>(
  approval: Approval<T> | undefined,
  toolInput: ApprovalContext<T>["toolInput"],
  authenticator: string
) {
  if (!approval) throw new Error("The tool must enforce its approval policy.");
  const policy = "request" in approval ? approval.request : approval;
  return policy({
    ...composioToolContext("account-1", { authenticator }),
    approvedTools: new Set(),
    toolInput,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  services.connection.mockResolvedValue({
    access: "full",
    state: "connected",
    email: "alice@example.com",
    provider: "mailru",
  });
  services.rule.mockResolvedValue("not-applicable");
});

describe("non-purchase mail actions", () => {
  const message = {
    provider: "mailru" as const,
    subject: "Meeting",
    body: "See you Thursday.",
    to: ["sam@example.com"],
  };
  const update = {
    provider: "mailru" as const,
    mailbox: "INBOX",
    uidValidity: "1",
    uids: [1, 2, 3, 4],
    action: "archive" as const,
  };

  it.each(["authjs", "browser-result"])(
    "sends and updates autonomously in %s",
    async (authenticator) => {
      expect(await decide(mailSend.approval, message, authenticator)).toBe(
        "not-applicable"
      );
      expect(await decide(mailUpdate.approval, update, authenticator)).toBe(
        "not-applicable"
      );
    }
  );

  it.each(["scheduled-worker", "scheduled-result", "background-task", "app"])(
    "denies sends and updates from %s without a card",
    async (authenticator) => {
      expect(
        await decide(mailSend.approval, message, authenticator)
      ).toMatchObject({ type: "denied" });
      expect(
        await decide(mailUpdate.approval, update, authenticator)
      ).toMatchObject({ type: "denied" });
    }
  );

  it("keeps read-only disconnected and saved-rule denials", async () => {
    services.connection.mockResolvedValue({
      access: "read_only",
      state: "connected",
      email: "alice@example.com",
      provider: "mailru",
    });
    expect(await decide(mailSend.approval, message, "authjs")).toMatchObject({
      type: "denied",
    });
    expect(
      await decide(mailUpdate.approval, update, "browser-result")
    ).toMatchObject({ type: "denied" });
    services.connection.mockResolvedValue({
      access: null,
      state: "disconnected",
      email: null,
      provider: "mailru",
    });
    expect(await decide(mailSend.approval, message, "authjs")).toMatchObject({
      type: "denied",
    });
    services.connection.mockResolvedValue({
      access: "full",
      state: "connected",
      email: "alice@example.com",
      provider: "mailru",
    });
    services.rule.mockResolvedValue("denied");
    expect(await decide(mailSend.approval, message, "authjs")).toBe("denied");
    expect(await decide(mailUpdate.approval, update, "authjs")).toBe("denied");
  });

  it("changes connections and expands read-only access only in the person's own turn", async () => {
    services.connection.mockResolvedValue({
      access: "read_only",
      state: "connected",
      email: "alice@example.com",
      provider: "mailru",
    });
    await Promise.all(
      [
        { action: "disconnect" as const, provider: "mailru" as const },
        {
          action: "connect" as const,
          access: "full" as const,
          provider: "mailru" as const,
        },
      ].map(async (input) => {
        expect(await decide(connectMail.approval, input, "authjs")).toBe(
          "not-applicable"
        );
        expect(
          await decide(connectMail.approval, input, "browser-result")
        ).toMatchObject({ type: "denied" });
      })
    );
  });

  it("keeps AgentMail sends autonomous but refuses new authority in background turns", async () => {
    const resolve = agentMail.events["turn.started"];
    if (!resolve) throw new Error("AgentMail must resolve its tools per turn.");
    const context = composioToolContext("account-1");
    const tools = await resolve(
      {},
      { ...context, channel: {}, messages: [], model: null }
    );
    if (!tools || "execute" in tools || !("agent-mail-send" in tools))
      throw new Error("AgentMail send is missing.");
    const agentMessage = {
      subject: message.subject,
      text: message.body,
      to: message.to,
    };
    const send = z
      .object({ approval: z.custom<Approval<typeof agentMessage>>() })
      .parse(tools["agent-mail-send"]);
    await Promise.all(
      ["authjs", "browser-result"].map(async (authenticator) => {
        expect(await decide(send.approval, agentMessage, authenticator)).toBe(
          "not-applicable"
        );
      })
    );
    expect(
      await decide(send.approval, agentMessage, "background-task")
    ).toMatchObject({ type: "denied" });
  });
});
