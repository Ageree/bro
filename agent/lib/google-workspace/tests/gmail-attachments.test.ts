import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  composioToolContext,
  type FakeComposio,
  fakeComposio,
} from "@tests/helpers/composio";

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

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => "read_only",
}));

import {
  readGmailAttachment,
  readGmailThread,
} from "@agent/lib/google-workspace/gmail";

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

const mailbox = "/gmail/v1/users/me";

let composio: FakeComposio;
/** What the fake Gmail answers per path, under the person's mailbox. */
let gmail: Map<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  composio = fakeComposio();
  composio.connect({
    authConfigId: "ac_google_read_only",
    id: "ca_google",
    toolkit: "googlesuper",
  });
  gmail = new Map<string, unknown>([
    ["/messages/message-1", { id: "message-1", payload }],
    [
      "/messages/message-1/attachments/rotating-id-1",
      { data: photo.toString("base64url") },
    ],
  ]);
  composio.proxy.mockImplementation(({ url }) => {
    const path = url.pathname.slice(mailbox.length);
    return gmail.has(path)
      ? { data: gmail.get(path) }
      : { data: { error: { message: "Not Found" } }, status: 404 };
  });
});

/** Paths of the attachment downloads the fake Gmail served. */
function attachmentReads() {
  return composio.proxy.mock.calls
    .map(([request]) => request.url.pathname)
    .filter((path) => path.includes("/attachments/"));
}

describe("Gmail attachments", () => {
  it("lists every attached file of a thread message by its part", async () => {
    gmail.set("/threads/thread-1", {
      id: "thread-1",
      messages: [{ id: "message-1", payload, threadId: "thread-1" }],
    });

    const thread = await readGmailThread(
      composioToolContext("ca_google"),
      "thread-1"
    );

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
      composioToolContext("ca_google"),
      "message-1",
      "1",
      1024
    );

    expect(attachmentReads()).toEqual([
      `${mailbox}/messages/message-1/attachments/rotating-id-1`,
    ]);
    expect(read).toEqual({
      bytes: new Uint8Array(photo),
      filename: "beach.jpg",
      kind: "bytes",
      mimeType: "image/jpeg",
    });
  });

  it("decodes a small part Gmail inlined into the message", async () => {
    const read = await readGmailAttachment(
      composioToolContext("ca_google"),
      "message-1",
      "2.1",
      1024
    );

    expect(attachmentReads()).toEqual([]);
    expect(read).toMatchObject({ filename: "inline.jpg", kind: "bytes" });
  });

  it("refuses an oversized part before fetching its bytes", async () => {
    const read = await readGmailAttachment(
      composioToolContext("ca_google"),
      "message-1",
      "3",
      10 * 1024 * 1024
    );

    expect(read).toEqual({ kind: "oversize" });
    expect(attachmentReads()).toEqual([]);
  });

  it("refuses bytes that outgrow the declared size", async () => {
    gmail.set("/messages/message-1", {
      id: "message-1",
      payload: {
        body: { attachmentId: "rotating-id-4", size: 2 },
        filename: "understated.jpg",
        mimeType: "image/jpeg",
        partId: "4",
      },
    });
    gmail.set("/messages/message-1/attachments/rotating-id-4", {
      data: photo.toString("base64url"),
    });

    const read = await readGmailAttachment(
      composioToolContext("ca_google"),
      "message-1",
      "4",
      4
    );

    expect(attachmentReads()).toHaveLength(1);
    expect(read).toEqual({ kind: "oversize" });
  });

  it("does not treat a body part as an attachment", async () => {
    const ctx = composioToolContext("ca_google");
    expect(await readGmailAttachment(ctx, "message-1", "0", 1024)).toEqual({
      kind: "missing",
    });
    expect(await readGmailAttachment(ctx, "message-1", "9", 1024)).toEqual({
      kind: "missing",
    });
  });
});
