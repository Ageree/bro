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
