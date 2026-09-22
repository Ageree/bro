import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Blob from "@vercel/blob";
import type * as GmailModule from "@agent/lib/google-workspace/gmail";
import type { readGmailAttachment } from "@agent/lib/google-workspace/gmail";
import type {
  findGmailAttachmentArtifact,
  saveGmailAttachmentArtifact,
} from "@db/services/gmail-attachments";

const mocks = vi.hoisted(() => ({
  find: vi.fn<typeof findGmailAttachmentArtifact>(),
  put: vi.fn<typeof Blob.put>(),
  read: vi.fn<typeof readGmailAttachment>(),
  save: vi.fn<typeof saveGmailAttachmentArtifact>(),
}));

vi.mock("@agent/lib/google-workspace/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof GmailModule>()),
  readGmailAttachment: mocks.read,
}));
vi.mock("@db/services/gmail-attachments", () => ({
  findGmailAttachmentArtifact: mocks.find,
  saveGmailAttachmentArtifact: mocks.save,
}));
vi.mock("@vercel/blob", async (importOriginal) => ({
  ...(await importOriginal<typeof Blob>()),
  put: mocks.put,
}));

import { gmailAttachment } from "@agent/tools/gmail";

const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
const jpeg = new Uint8Array(16);
jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
const savedRow = {
  byteSize: jpeg.byteLength,
  contentHash: "hash",
  createdAt: new Date(),
  createdByUserId: "user-1",
  filename: "beach.jpg",
  gmailMessageId: "message-1",
  gmailPartId: "1",
  id: artifactId,
  mediaType: "image/jpeg",
  rootSessionId: "session-1",
  storagePathname: "gmail-attachments/workspace/beach",
  workspaceId: "personal:workspace",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.find.mockResolvedValue(undefined);
  mocks.save.mockImplementation(async (_scope, artifact) => ({
    ...savedRow,
    ...artifact,
    createdAt: new Date(),
    createdByUserId: "user-1",
    id: artifact.id ?? artifactId,
    workspaceId: "personal:workspace",
  }));
  mocks.put.mockResolvedValue({
    contentDisposition: "",
    contentType: "image/jpeg",
    downloadUrl: "https://blob.example/download",
    etag: '"etag"',
    pathname: "gmail-attachments/workspace/beach",
    url: "https://blob.example/beach",
  });
});

describe("gmail-attachment", () => {
  it("stores an attachment privately under the type its bytes carry", async () => {
    mocks.read.mockResolvedValue({
      bytes: jpeg,
      filename: "beach",
      kind: "bytes",
      mimeType: "application/octet-stream",
    });
    const context = toolContext();

    const result = await attach(
      [{ messageId: "message-1", partId: "1" }],
      context
    );

    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(
      context,
      "message-1",
      "1",
      10 * 1024 * 1024
    );
    const [pathname, body, options] = mocks.put.mock.calls[0] ?? [];
    expect(pathname).toMatch(
      /^gmail-attachments\/[0-9a-f]{32}\/[0-9a-f-]{36}$/u
    );
    expect(body).toEqual(Buffer.from(jpeg));
    expect(options).toMatchObject({
      access: "private",
      addRandomSuffix: false,
      contentType: "image/jpeg",
    });
    const saved = mocks.save.mock.calls[0]?.[1];
    expect(mocks.save.mock.calls[0]?.[0]).toEqual({
      userId: "user-1",
      workspaceId: "personal:workspace",
    });
    expect(saved).toMatchObject({
      byteSize: 16,
      filename: "beach",
      gmailMessageId: "message-1",
      gmailPartId: "1",
      mediaType: "image/jpeg",
      rootSessionId: "session-1",
      storagePathname: pathname,
    });
    expect(result.attachments).toEqual([
      {
        filename: "beach",
        markdown: `![beach](/artifacts/${String(saved?.id)})`,
        messageId: "message-1",
        mimeType: "image/jpeg",
        partId: "1",
        size: 16,
        status: "ready",
      },
    ]);
  });

  it("reuses the copy this session already stored", async () => {
    mocks.find.mockResolvedValue(savedRow);

    const result = await attach([{ messageId: "message-1", partId: "1" }]);

    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(result.attachments).toEqual([
      expect.objectContaining({
        markdown: `![beach.jpg](/artifacts/${artifactId})`,
        status: "ready",
      }),
    ]);
  });

  it("reports each unavailable attachment without failing the rest", async () => {
    mocks.read
      .mockResolvedValueOnce({ kind: "oversize" })
      .mockResolvedValueOnce({ kind: "missing" })
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({
        bytes: jpeg,
        filename: "beach.jpg",
        kind: "bytes",
        mimeType: "image/jpeg",
      });

    const result = await attach([
      { messageId: "message-1", partId: "1" },
      { messageId: "message-1", partId: "2" },
      { messageId: "gone", partId: "1" },
      { messageId: "message-2", partId: "1" },
    ]);

    expect(result.attachments.map((item) => item.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "ready",
    ]);
    expect(result.attachments[0]).toMatchObject({
      reason: "Larger than 10 MB.",
    });
    expect(mocks.put).toHaveBeenCalledOnce();
  });

  it("lets an authorization failure fail the call", async () => {
    mocks.read.mockRejectedValue({ response: { status: 401 } });

    await expect(
      gmailAttachment.execute(
        { attachments: [{ messageId: "message-1", partId: "1" }] },
        toolContext()
      )
    ).rejects.toEqual({ response: { status: 401 } });
  });

  it("refuses a call without an authenticated user", async () => {
    await expect(
      gmailAttachment.execute(
        { attachments: [{ messageId: "message-1", partId: "1" }] },
        toolContext(null)
      )
    ).rejects.toThrow("authenticated user");
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

async function attach(
  attachments: { readonly messageId: string; readonly partId: string }[],
  context = toolContext()
) {
  const result = await gmailAttachment.execute({ attachments }, context);
  if (Symbol.asyncIterator in result) {
    throw new Error("gmail-attachment returns one result, not a stream.");
  }
  return result;
}

function toolContext(
  current: ToolContext["session"]["auth"]["current"] = {
    attributes: { workspaceId: "personal:workspace" },
    authenticator: "photon-imessage",
    principalId: "user-1",
    principalType: "user",
  }
) {
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
      throw new Error("Token access is outside this focused test.");
    },
    requireAuth() {
      throw new Error("Authorization is outside this focused test.");
    },
    session: {
      auth: { current, initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "gmail-attachment",
  } satisfies ToolContext;
}
