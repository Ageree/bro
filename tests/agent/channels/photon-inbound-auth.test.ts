import type { PhotonIMessageChannelConfig } from "eve/channels/photon";
import { Message } from "chat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@shared/environment";
import type * as ScopeService from "@db/services/scope";
// oxlint-disable-next-line import/no-unassigned-import -- Loads the production module so the mocked channel factory can capture its configuration.
import "@agent/channels/photon";

const capture = vi.hoisted(() => ({
  // SAFETY: The mocked channel factory replaces this value during module loading.
  config: undefined as PhotonIMessageChannelConfig | undefined,
  ensureUser:
    vi.fn<() => Promise<{ created: boolean; userId: string } | undefined>>(),
  messageQuotaGate: vi.fn<
    () => Promise<{
      allowed: boolean;
      paywallText: string | undefined;
    }>
  >(),
  claimIntroduction: vi.fn<typeof ScopeService.claimWorkspaceIntroduction>(),
  post: vi.fn<InboundContext["thread"]["post"]>(),
}));

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: {
      ...original.env,
      IMESSAGE_PROJECT_ID: "photon-test-project",
      IMESSAGE_PROJECT_SECRET: "photon-test-secret",
      IMESSAGE_WEBHOOK_SECRET: "photon-test-webhook-secret",
    },
  };
});
vi.mock(import("eve/channels/photon"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    photonIMessageChannel(config: PhotonIMessageChannelConfig) {
      capture.config = config;
      return original.photonIMessageChannel(config);
    },
  };
});
vi.mock("@db/services/auth/phone-user", () => ({
  ensureVerifiedPhoneUser: capture.ensureUser,
}));
vi.mock("@agent/lib/billing/quota", () => ({
  messageQuotaGate: capture.messageQuotaGate,
}));
vi.mock("@db/services/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof ScopeService>()),
  claimWorkspaceIntroduction: capture.claimIntroduction,
}));

const onMessage = capture.config?.onMessage;
if (!onMessage) {
  throw new Error("The Photon channel must route inbound messages.");
}

describe("Photon inbound authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capture.messageQuotaGate.mockResolvedValue({
      allowed: true,
      paywallText: undefined,
    });
    capture.claimIntroduction.mockResolvedValue(false);
  });

  it("verifies webhooks with the configured Photon signing secret", () => {
    expect(capture.config?.webhookSecret).toBe("photon-test-webhook-secret");
    expect(capture.config?.webhookVerifier).toBeUndefined();
  });

  it("resolves Photon project credentials lazily", () => {
    expect(capture.config?.credentials()).toEqual({
      projectId: "photon-test-project",
      projectSecret: "photon-test-secret",
    });
  });

  it("drops messages this deployment sent itself", async () => {
    await expect(
      onMessage(threadContext(), photonMessage("+15550100011", { isMe: true }))
    ).resolves.toBeNull();
    expect(capture.ensureUser).not.toHaveBeenCalled();
  });

  it("drops messages from handles that are not phone numbers", async () => {
    await expect(
      onMessage(threadContext(), photonMessage("someone@example.com"))
    ).resolves.toBeNull();
    expect(capture.ensureUser).not.toHaveBeenCalled();
  });

  it("drops messages whose phone number has no usable account", async () => {
    capture.ensureUser.mockResolvedValue(undefined);

    await expect(
      onMessage(threadContext(), photonMessage("+15550100011"))
    ).resolves.toBeNull();
    expect(capture.ensureUser).toHaveBeenCalledExactlyOnceWith("+15550100011");
  });

  it("scopes a known handle to that user's own workspace", async () => {
    capture.ensureUser.mockResolvedValue({ created: false, userId: "user-1" });

    const result = await onMessage(
      threadContext(),
      photonMessage("+15550100011")
    );

    expect(result?.auth?.principalId).toBe("better-auth:user-1");
    expect(result?.auth?.attributes).toMatchObject({
      conversationChannel: "photon",
      conversationId: "imessage:iMessage;-;+15550100011",
      phoneNumber: "+15550100011",
      photonMessageId: "message-1",
    });
    expect(result?.auth?.attributes.workspaceId).toMatch(
      /^personal:[0-9a-f]{32}$/
    );
  });

  it("onboards a first-time number through the verified phone account", async () => {
    capture.ensureUser
      .mockResolvedValueOnce({ created: true, userId: "user-new" })
      .mockResolvedValueOnce({ created: false, userId: "user-new" });

    const first = await onMessage(
      threadContext(),
      photonMessage("+15550100011")
    );
    const second = await onMessage(
      threadContext(),
      photonMessage("+15550100011")
    );

    expect(capture.ensureUser).toHaveBeenCalledTimes(2);
    expect(first?.auth?.principalId).toBe("better-auth:user-new");
    expect(second?.auth?.principalId).toBe("better-auth:user-new");
  });

  it("tells the model when it is answering a brand new person", async () => {
    capture.ensureUser.mockResolvedValue({
      created: true,
      userId: "user-new",
    });
    capture.claimIntroduction.mockResolvedValue(true);

    const result = await onMessage(
      threadContext(),
      photonMessage("+15550100011")
    );

    expect(result?.context?.join("\n")).toContain("`first-contact`");
    expect(result?.context?.join("\n")).toContain("первое в жизни сообщение");
  });

  it("answers an over-limit message with one paywall bubble a day", async () => {
    capture.ensureUser.mockResolvedValue({ created: false, userId: "user-1" });
    capture.messageQuotaGate.mockResolvedValueOnce({
      allowed: false,
      paywallText: "Лимит на сегодня исчерпан",
    });
    const context = threadContext();

    const paywalled = await onMessage(context, photonMessage("+15550100011"));

    expect(paywalled).toBeNull();
    expect(capture.post).toHaveBeenCalledExactlyOnceWith({
      raw: "Лимит на сегодня исчерпан",
    });

    // The rest of the day is turned away without saying so again.
    capture.messageQuotaGate.mockResolvedValueOnce({
      allowed: false,
      paywallText: undefined,
    });
    const silent = await onMessage(context, photonMessage("+15550100011"));

    expect(silent).toBeNull();
    expect(capture.post).toHaveBeenCalledTimes(1);
  });

  // Someone who signed up on the web and writes to iMessage for the first time
  // gets an account that already exists, and is still meeting Bro now.
  it("introduces Bro on the workspace's first message even for an existing account", async () => {
    capture.ensureUser.mockResolvedValue({ created: false, userId: "user-1" });
    capture.claimIntroduction.mockResolvedValue(true);

    const result = await onMessage(
      threadContext(),
      photonMessage("+15550100011")
    );

    expect(result?.context?.join("\n")).toContain("`first-contact`");
  });

  it("says nothing about a first contact for a returning person", async () => {
    capture.ensureUser.mockResolvedValue({
      created: false,
      userId: "user-1",
    });

    const result = await onMessage(
      threadContext(),
      photonMessage("+15550100011")
    );

    expect(result?.context).toEqual([]);
  });
});

type InboundContext = Parameters<
  NonNullable<PhotonIMessageChannelConfig["onMessage"]>
>[0];

interface ThreadIdentity {
  readonly thread: Pick<InboundContext["thread"], "id" | "post">;
}

function threadContext(): InboundContext {
  const identity: ThreadIdentity = {
    thread: { id: "imessage:iMessage;-;+15550100011", post: capture.post },
  };
  // SAFETY: The inbound policy reads only the thread id and `post` from this context.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete Chat SDK thread mock would add unrelated methods.
  return identity as InboundContext;
}

function photonMessage(handle: string, options?: { readonly isMe?: boolean }) {
  return new Message({
    attachments: [],
    author: {
      fullName: handle,
      isBot: false,
      isMe: options?.isMe ?? false,
      userId: handle,
      userName: handle,
    },
    formatted: { children: [], type: "root" },
    id: "message-1",
    metadata: {
      dateSent: new Date("2026-09-03T00:00:00.000Z"),
      edited: false,
    },
    raw: {},
    text: "list my vault items",
    threadId: "imessage:iMessage;-;+15550100011",
  });
}
