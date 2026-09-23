import type * as GmailPackage from "@googleapis/gmail";
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessScopeForUser } from "@shared/identity/access-scope";

interface GmailPart {
  readonly body?: {
    readonly attachmentId?: string;
    readonly data?: string;
    readonly size?: number;
  };
  readonly filename?: string;
  readonly mimeType?: string;
  readonly partId?: string;
  readonly parts?: readonly GmailPart[];
}

const google = vi.hoisted(() => ({
  getAttachment:
    vi.fn<
      (request: {
        readonly id: string;
        readonly messageId: string;
      }) => Promise<{ data: { data?: string } }>
    >(),
  getMessage:
    vi.fn<
      (request: {
        readonly id: string;
      }) => Promise<{ data: { id: string; payload: GmailPart } }>
    >(),
  getThread: vi.fn<
    () => Promise<{
      data: {
        id: string;
        messages: { id: string; payload: GmailPart; threadId: string }[];
      };
    }>
  >(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => "read_only",
}));

vi.mock("@googleapis/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof GmailPackage>()),
  gmail: () => ({
    users: {
      messages: {
        attachments: { get: google.getAttachment },
        get: google.getMessage,
      },
      threads: { get: google.getThread },
    },
  }),
}));

import {
  readGmailAttachment,
  readGmailThread,
} from "@agent/lib/google-workspace/gmail";

const scope = accessScopeForUser("better-auth:user-1");
const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const payload: GmailPart = {
  mimeType: "multipart/mixed",
  partId: "",
  parts: [
    {
      body: { data: Buffer.from("Держи фотки").toString("base64url") },
      filename: "",
      mimeType: "text/plain",
      partId: "0",
    },
    {
      body: { attachmentId: "rotating-id-1", size: photo.byteLength },
      filename: "beach.jpg",
      mimeType: "image/jpeg",
      partId: "1",
    },
    {
      mimeType: "multipart/related",
      partId: "2",
      parts: [
        {
          body: { data: photo.toString("base64url"), size: photo.byteLength },
          filename: "inline.jpg",
          mimeType: "image/jpeg",
          partId: "2.1",
        },
      ],
    },
    {
      body: { attachmentId: "rotating-id-3", size: 11 * 1024 * 1024 },
      filename: "video.mov",
      mimeType: "video/quicktime",
      partId: "3",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  google.getMessage.mockResolvedValue({ data: { id: "message-1", payload } });
  google.getAttachment.mockResolvedValue({
    data: { data: photo.toString("base64url") },
  });
});

describe("Gmail attachments", () => {
  it("lists every attached file of a thread message by its part", async () => {
    google.getThread.mockResolvedValue({
      data: {
        id: "thread-1",
        messages: [{ id: "message-1", payload, threadId: "thread-1" }],
      },
    });

    const thread = await readGmailThread(toolContext(), "thread-1");

    expect(thread.messages[0]?.attachments).toEqual([
      {
        filename: "beach.jpg",
        mimeType: "image/jpeg",
        partId: "1",
        size: photo.byteLength,
      },
      {
        filename: "inline.jpg",
        mimeType: "image/jpeg",
        partId: "2.1",
        size: photo.byteLength,
      },
      {
        filename: "video.mov",
        mimeType: "video/quicktime",
        partId: "3",
        size: 11 * 1024 * 1024,
      },
    ]);
    expect(thread.messages[0]?.body).toBe("Держи фотки");
  });

  it("downloads a part through the attachment id of the current read", async () => {
    const read = await readGmailAttachment(
      toolContext(),
      "message-1",
      "1",
      1024
    );

    expect(google.getAttachment).toHaveBeenCalledExactlyOnceWith(
      { id: "rotating-id-1", messageId: "message-1", userId: "me" },
      expect.anything()
    );
    expect(read).toEqual({
      bytes: new Uint8Array(photo),
      filename: "beach.jpg",
      kind: "bytes",
      mimeType: "image/jpeg",
    });
  });

  it("decodes a small part Gmail inlined into the message", async () => {
    const read = await readGmailAttachment(
      toolContext(),
      "message-1",
      "2.1",
      1024
    );

    expect(google.getAttachment).not.toHaveBeenCalled();
    expect(read).toMatchObject({ filename: "inline.jpg", kind: "bytes" });
  });

  it("refuses an oversized part before fetching its bytes", async () => {
    const read = await readGmailAttachment(
      toolContext(),
      "message-1",
      "3",
      10 * 1024 * 1024
    );

    expect(read).toEqual({ kind: "oversize" });
    expect(google.getAttachment).not.toHaveBeenCalled();
  });

  it("refuses bytes that outgrow the declared size", async () => {
    google.getMessage.mockResolvedValue({
      data: {
        id: "message-1",
        payload: {
          body: { attachmentId: "rotating-id-4", size: 2 },
          filename: "understated.jpg",
          mimeType: "image/jpeg",
          partId: "4",
        },
      },
    });

    const read = await readGmailAttachment(toolContext(), "message-1", "4", 4);

    expect(google.getAttachment).toHaveBeenCalledOnce();
    expect(read).toEqual({ kind: "oversize" });
  });

  it("does not treat a body part as an attachment", async () => {
    expect(
      await readGmailAttachment(toolContext(), "message-1", "0", 1024)
    ).toEqual({ kind: "missing" });
    expect(
      await readGmailAttachment(toolContext(), "message-1", "9", 1024)
    ).toEqual({ kind: "missing" });
  });
});

function toolContext() {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    async getToken() {
      return { token: "google-access-token" };
    },
    requireAuth() {
      throw new Error("Authorization is outside this focused test.");
    },
    session: {
      auth: {
        current: {
          attributes: { workspaceId: scope.workspaceId },
          authenticator: "gmail-attachment-test",
          principalId: scope.userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "gmail-attachment",
  } satisfies ToolContext;
}
