import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getGoogleWorkspaceAccess } from "@db/services/settings";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { type FakeComposio, fakeComposio } from "@tests/helpers/composio";

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: settings.access,
}));

import { probeGoogleSignals } from "@agent/lib/proactive/probe";

const scope = accessScopeForUser("better-auth:user-1");
const now = new Date("2026-09-24T09:00:00.000Z");
const window = {
  mailAfter: new Date("2026-09-24T08:00:00.000Z"),
  now,
  timeZone: "Europe/Moscow",
};

let composio: FakeComposio;

beforeEach(() => {
  vi.clearAllMocks();
  settings.access.mockResolvedValue("full");
  composio = fakeComposio();
  composio.proxy.mockImplementation(({ url }) =>
    url.hostname === "gmail.googleapis.com"
      ? { data: { messages: [{ id: "m1", threadId: "t1" }] } }
      : {
          data: {
            items: [
              {
                id: "flight",
                start: { dateTime: "2026-09-25T06:00:00.000Z" },
                status: "confirmed",
              },
            ],
          },
        }
  );
});

describe("probeGoogleSignals", () => {
  it("reports a person without a Google account as disconnected", async () => {
    await expect(probeGoogleSignals(scope, window)).resolves.toEqual({
      state: "disconnected",
    });
    expect(composio.proxy).not.toHaveBeenCalled();
  });

  it("lists new mail and upcoming events through the person's account", async () => {
    composio.connect({ id: "ca_google", toolkit: "googlesuper" });

    await expect(probeGoogleSignals(scope, window)).resolves.toEqual({
      signals: [
        {
          dedupeKey: "flight@2026-09-25T06:00:00.000Z",
          itemId: "flight",
          source: "calendar",
          threadId: null,
        },
        { dedupeKey: "m1", itemId: "m1", source: "gmail", threadId: "t1" },
      ],
      state: "connected",
    });
    const requests = composio.proxy.mock.calls.map(([request]) => request);
    expect(
      requests.every(
        ({ connectedAccountId }) => connectedAccountId === "ca_google"
      )
    ).toBe(true);
    expect(
      requests
        .find(({ url }) => url.hostname === "gmail.googleapis.com")
        ?.url.searchParams.get("q")
    ).toContain("in:inbox after:");
  });

  it("keeps only what may not wait for the morning at night", async () => {
    composio.connect({ id: "ca_google", toolkit: "googlesuper" });
    const subjects = new Map([
      ["m1", "го в субботу на шашлыки?"],
      ["m2", "Изменение выхода на посадку: рейс SU 1234"],
    ]);
    composio.proxy.mockImplementation(({ url }) => {
      if (url.hostname !== "gmail.googleapis.com") {
        return {
          data: {
            items: [
              {
                id: "flight",
                location: "Шереметьево",
                start: { dateTime: "2026-09-24T14:00:00.000Z" },
                status: "confirmed",
                summary: "Рейс SU 1234",
              },
              {
                id: "standup",
                start: { dateTime: "2026-09-24T12:00:00.000Z" },
                status: "confirmed",
                summary: "Планёрка",
              },
            ],
          },
        };
      }
      const id = url.pathname.split("/").at(-1) ?? "";
      return subjects.has(id)
        ? {
            data: {
              id,
              payload: {
                headers: [{ name: "Subject", value: subjects.get(id) }],
              },
              threadId: `t-${id}`,
            },
          }
        : {
            data: {
              messages: [
                { id: "m1", threadId: "t-m1" },
                { id: "m2", threadId: "t-m2" },
              ],
            },
          };
    });

    await expect(
      probeGoogleSignals(scope, { ...window, nightOnly: true })
    ).resolves.toEqual({
      signals: [
        {
          dedupeKey: "flight@2026-09-24T14:00:00.000Z",
          itemId: "flight",
          source: "calendar",
          threadId: null,
        },
        { dedupeKey: "m2", itemId: "m2", source: "gmail", threadId: "t-m2" },
      ],
      state: "connected",
    });
    const subjectRead = composio.proxy.mock.calls
      .map(([request]) => request.url)
      .find((url) => url.pathname.endsWith("/messages/m2"));
    expect(subjectRead?.searchParams.get("format")).toBe("metadata");
    expect(subjectRead?.searchParams.getAll("metadataHeaders")).toEqual([
      "Subject",
    ]);
  });

  it("looks under the read-only level's account for a read-only workspace", async () => {
    settings.access.mockResolvedValue("read_only");
    composio.connect({ id: "ca_full", toolkit: "googlesuper" });

    await expect(probeGoogleSignals(scope, window)).resolves.toEqual({
      state: "disconnected",
    });
  });

  it("treats a grant Google rejects as a disconnect", async () => {
    composio.connect({ id: "ca_google", toolkit: "googlesuper" });
    composio.proxy.mockResolvedValue({ data: {}, status: 401 });

    await expect(probeGoogleSignals(scope, window)).resolves.toEqual({
      state: "disconnected",
    });
  });
});
