import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Blob from "@vercel/blob";
import type {
  readDriveFile,
  searchDrive,
} from "@agent/lib/google-workspace/drive";
import type {
  findDriveFileArtifact,
  saveDriveFileArtifact,
} from "@db/services/drive-files";

const mocks = vi.hoisted(() => ({
  del: vi.fn<typeof Blob.del>(),
  find: vi.fn<typeof findDriveFileArtifact>(),
  put: vi.fn<typeof Blob.put>(),
  read: vi.fn<typeof readDriveFile>(),
  save: vi.fn<typeof saveDriveFileArtifact>(),
}));

vi.mock("@agent/lib/google-workspace/drive", () => ({
  readDriveFile: mocks.read,
  searchDrive: vi.fn<typeof searchDrive>(),
}));
vi.mock("@db/services/drive-files", () => ({
  findDriveFileArtifact: mocks.find,
  saveDriveFileArtifact: mocks.save,
}));
vi.mock("@vercel/blob", async (importOriginal) => ({
  ...(await importOriginal<typeof Blob>()),
  del: mocks.del,
  put: mocks.put,
}));

import { driveRead } from "@agent/tools/drive";
import { googleWorkspaceScopes } from "@shared/google-workspace/connection";

const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
const pdf = new TextEncoder().encode("%PDF-1.7\n%passport\n");
const file = {
  id: "file-1",
  mimeType: "application/pdf",
  modifiedTime: "2026-09-01T10:00:00.000Z",
  name: "Passport.pdf",
  owners: ["Ada"],
  size: pdf.byteLength,
  version: "7",
  webViewLink: "https://drive.google.com/file/d/file-1/view",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.find.mockResolvedValue(undefined);
  mocks.save.mockImplementation(async (_scope, artifact) => ({
    ...artifact,
    createdAt: new Date(),
    createdByUserId: "user-1",
    id: artifact.id ?? artifactId,
    workspaceId: "personal:workspace",
  }));
  mocks.put.mockResolvedValue({
    contentDisposition: "",
    contentType: "application/pdf",
    downloadUrl: "https://blob.example/download",
    etag: '"etag"',
    pathname: "drive-files/workspace/passport",
    url: "https://blob.example/passport",
  });
});

describe("Drive access", () => {
  it.each(["full", "read_only"] as const)(
    "asks Google for read-only Drive access at the %s level",
    (access) => {
      expect(googleWorkspaceScopes[access]).toContain(
        "https://www.googleapis.com/auth/drive.readonly"
      );
      expect(googleWorkspaceScopes[access]).not.toContain(
        "https://www.googleapis.com/auth/drive"
      );
    }
  );
});

describe("drive-read", () => {
  it("returns a Google Doc as text", async () => {
    mocks.read.mockResolvedValue({
      file: { ...file, mimeType: "application/vnd.google-apps.document" },
      kind: "text",
      text: "Flight LX 318, seat 12A",
      truncated: false,
    });

    const result = await read();

    expect(result).toMatchObject({
      kind: "text",
      text: "Flight LX 318, seat 12A",
    });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("stores a PDF as a private artifact and shows it to the model", async () => {
    mocks.read.mockResolvedValue({ bytes: pdf, file, kind: "bytes" });

    const result = await read();

    const [pathname, , options] = mocks.put.mock.calls[0] ?? [];
    expect(pathname).toMatch(/^drive-files\/[0-9a-f]{32}\/[0-9a-f-]{36}$/u);
    expect(options).toMatchObject({
      access: "private",
      contentType: "application/pdf",
    });
    expect(mocks.save.mock.calls[0]?.[1]).toMatchObject({
      driveFileId: "file-1",
      driveVersion: "7",
      filename: "Passport.pdf",
      mediaType: "application/pdf",
      rootSessionId: "session-1",
    });
    expect(result).toMatchObject({
      kind: "file",
      mediaType: "application/pdf",
      modelData: Buffer.from(pdf).toString("base64"),
    });
    if (result.kind !== "file") throw new Error("Expected a file result.");
    expect(result.markdown).toMatch(
      /^!\[Passport\.pdf\]\(\/artifacts\/[0-9a-f-]{36}\)$/u
    );

    const modelOutput = driveRead.toModelOutput?.(result);
    expect(modelOutput).toMatchObject({ type: "content" });
    expect(JSON.stringify(modelOutput)).toContain(
      '"mediaType":"application/pdf"'
    );
  });

  it("reuses the copy this session already stored", async () => {
    mocks.read.mockResolvedValue({ bytes: pdf, file, kind: "bytes" });
    mocks.find.mockResolvedValue({
      byteSize: pdf.byteLength,
      contentHash: "hash",
      createdAt: new Date(),
      createdByUserId: "user-1",
      driveFileId: "file-1",
      driveVersion: "7",
      filename: "Passport.pdf",
      id: artifactId,
      mediaType: "application/pdf",
      rootSessionId: "session-1",
      storagePathname: "drive-files/workspace/passport",
      workspaceId: "personal:workspace",
    });

    const result = await read();

    expect(mocks.put).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      markdown: `![Passport.pdf](/artifacts/${artifactId})`,
    });
  });

  it("returns metadata for a file it does not download", async () => {
    mocks.read.mockResolvedValue({
      file: { ...file, mimeType: "application/zip" },
      kind: "metadata",
      reason: "Only text, images, and PDFs are downloaded.",
    });

    await expect(read()).resolves.toMatchObject({ kind: "metadata" });
  });
});

async function read(fileId = "file-1") {
  const result = await driveRead.execute({ fileId }, toolContext());
  if (Symbol.asyncIterator in result) {
    throw new Error("drive-read returns one result, not a stream.");
  }
  return result;
}

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
      throw new Error("Token access is outside this focused test.");
    },
    requireAuth() {
      throw new Error("Authorization is outside this focused test.");
    },
    session: {
      auth: {
        current: {
          attributes: { workspaceId: "personal:workspace" },
          authenticator: "photon-imessage",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "drive-read",
  } satisfies ToolContext;
}
