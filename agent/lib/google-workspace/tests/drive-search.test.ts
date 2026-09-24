import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  composioToolContext,
  type FakeComposio,
  fakeComposio,
} from "@tests/helpers/composio";

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => "read_only",
}));

import { searchDrive } from "@agent/lib/google-workspace/drive";

let composio: FakeComposio;

const threeFiles = {
  files: [
    { id: "old", modifiedTime: "2025-07-07T13:56:37.000Z", name: "a.pdf" },
    { id: "new", modifiedTime: "2025-07-07T14:18:41.000Z", name: "b.pdf" },
    { id: "mid", modifiedTime: "2025-07-07T14:03:21.000Z", name: "c.pdf" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  composio = fakeComposio();
  composio.connect({
    authConfigId: "ac_google_read_only",
    id: "ca_google",
    toolkit: "googlesuper",
  });
  composio.proxy.mockResolvedValue({ data: threeFiles });
});

/** The query string of the n-th Drive list call. */
function listQuery(call = 0) {
  const url = composio.proxy.mock.calls[call]?.[0].url;
  expect(url?.pathname).toBe("/drive/v3/files");
  return url?.searchParams;
}

describe("searchDrive", () => {
  it("lists the newest files of a kind through Drive's own ordering", async () => {
    await searchDrive(composioToolContext("ca_google"), {
      kind: "pdf",
      maxResults: 5,
    });

    expect(composio.proxy).toHaveBeenCalledOnce();
    const query = listQuery();
    expect(query?.get("orderBy")).toBe("modifiedTime desc");
    expect(query?.get("pageSize")).toBe("5");
    expect(query?.get("q")).toBe(
      "trashed = false and mimeType = 'application/pdf'"
    );
  });

  it("searches words without orderBy, which Drive refuses with fullText", async () => {
    await searchDrive(composioToolContext("ca_google"), {
      kind: "pdf",
      maxResults: 10,
      query: "O'Brien",
    });

    const query = listQuery();
    expect(query?.has("orderBy")).toBe(false);
    expect(query?.get("q")).toBe(
      "trashed = false and (name contains 'O\\'Brien' or fullText contains 'O\\'Brien') and mimeType = 'application/pdf'"
    );
  });

  it("returns the files newest first", async () => {
    const files = await searchDrive(composioToolContext("ca_google"), {
      maxResults: 10,
      query: "pdf",
    });

    expect(files.map(({ id }) => id)).toEqual(["new", "mid", "old"]);
  });

  it("sorts every page of a word search before keeping the newest", async () => {
    composio.proxy
      .mockResolvedValueOnce({
        data: {
          files: [
            { id: "old", modifiedTime: "2025-01-01T00:00:00.000Z", name: "a" },
          ],
          nextPageToken: "page-2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [
            { id: "new", modifiedTime: "2025-09-01T00:00:00.000Z", name: "b" },
          ],
        },
      });

    const files = await searchDrive(composioToolContext("ca_google"), {
      maxResults: 1,
      query: "отчёт",
    });

    expect(files.map(({ id }) => id)).toEqual(["new"]);
    expect(composio.proxy).toHaveBeenCalledTimes(2);
    const second = listQuery(1);
    expect(second?.get("pageSize")).toBe("100");
    expect(second?.get("pageToken")).toBe("page-2");
  });
});
