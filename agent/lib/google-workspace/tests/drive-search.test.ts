import type * as DrivePackage from "@googleapis/drive";
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessScopeForUser } from "@shared/identity/access-scope";

const google = vi.hoisted(() => ({
  list: vi.fn<
    (request: {
      readonly orderBy?: string;
      readonly pageSize: number;
      readonly q: string;
    }) => Promise<{
      data: { files: { id: string; modifiedTime: string; name: string }[] };
    }>
  >(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => "read_only",
}));

vi.mock("@googleapis/drive", async (importOriginal) => ({
  ...(await importOriginal<typeof DrivePackage>()),
  drive: () => ({ files: { list: google.list } }),
}));

import { searchDrive } from "@agent/lib/google-workspace/drive";

const scope = accessScopeForUser("better-auth:user-1");

beforeEach(() => {
  vi.clearAllMocks();
  google.list.mockResolvedValue({
    data: {
      files: [
        { id: "old", modifiedTime: "2025-07-07T13:56:37.000Z", name: "a.pdf" },
        { id: "new", modifiedTime: "2025-07-07T14:18:41.000Z", name: "b.pdf" },
        { id: "mid", modifiedTime: "2025-07-07T14:03:21.000Z", name: "c.pdf" },
      ],
    },
  });
});

describe("searchDrive", () => {
  it("lists the newest files of a kind through Drive's own ordering", async () => {
    await searchDrive(toolContext(), { kind: "pdf", maxResults: 5 });

    expect(google.list).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        orderBy: "modifiedTime desc",
        pageSize: 5,
        q: "trashed = false and mimeType = 'application/pdf'",
      }),
      expect.anything()
    );
  });

  it("searches words without orderBy, which Drive refuses with fullText", async () => {
    await searchDrive(toolContext(), {
      kind: "pdf",
      maxResults: 10,
      query: "O'Brien",
    });

    const [request] = google.list.mock.calls[0] ?? [];
    expect(request?.orderBy).toBeUndefined();
    expect(request?.q).toBe(
      "trashed = false and (name contains 'O\\'Brien' or fullText contains 'O\\'Brien') and mimeType = 'application/pdf'"
    );
  });

  it("returns the files newest first", async () => {
    const files = await searchDrive(toolContext(), {
      maxResults: 10,
      query: "pdf",
    });

    expect(files.map(({ id }) => id)).toEqual(["new", "mid", "old"]);
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
          authenticator: "drive-search-test",
          principalId: scope.userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "drive-search",
  } satisfies ToolContext;
}
