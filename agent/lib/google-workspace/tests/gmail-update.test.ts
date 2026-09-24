import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  composioToolContext,
  type FakeComposio,
  fakeComposio,
} from "@tests/helpers/composio";

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => "full",
}));

import {
  gmailSecurityAlertQuery,
  updateGmail,
} from "@agent/lib/google-workspace/gmail";

let composio: FakeComposio;

beforeEach(() => {
  vi.clearAllMocks();
  composio = fakeComposio();
  composio.connect({ id: "ca_google", toolkit: "googlesuper" });
  composio.proxy.mockImplementation(({ url }) =>
    url.pathname.endsWith("/messages")
      ? { data: { messages: [{ id: "security-alert" }, { id: "elsewhere" }] } }
      : { data: null, status: 204 }
  );
});

/** The searches and batch changes Gmail received, in order. */
function gmailCalls() {
  return composio.proxy.mock.calls.map(([request]) => ({
    ids: z.object({ ids: z.array(z.string()) }).safeParse(request.body).data
      ?.ids,
    method: request.method,
    path: request.url.pathname,
    query: request.url.searchParams.get("q"),
  }));
}

describe("updateGmail", () => {
  it("never archives a security alert", async () => {
    const result = await updateGmail(
      composioToolContext("ca_google"),
      ["newsletter", "security-alert", "receipt"],
      "archive"
    );

    expect(gmailCalls()).toEqual([
      {
        ids: undefined,
        method: "GET",
        path: "/gmail/v1/users/me/messages",
        query: gmailSecurityAlertQuery,
      },
      {
        ids: ["newsletter", "receipt"],
        method: "POST",
        path: "/gmail/v1/users/me/messages/batchModify",
        query: null,
      },
    ]);
    expect(composio.proxy.mock.calls[1]?.[0].body).toEqual({
      addLabelIds: [],
      ids: ["newsletter", "receipt"],
      removeLabelIds: ["INBOX"],
    });
    expect(result).toEqual({
      action: "archive",
      keptSecurityAlerts: ["security-alert"],
      updatedCount: 2,
    });
  });

  it("calls nothing when every message is a security alert", async () => {
    const result = await updateGmail(
      composioToolContext("ca_google"),
      ["security-alert"],
      "archive"
    );

    expect(gmailCalls().map(({ method }) => method)).toEqual(["GET"]);
    expect(result.updatedCount).toBe(0);
  });

  it("looks for alerts only before archiving", async () => {
    await updateGmail(
      composioToolContext("ca_google"),
      ["security-alert"],
      "star"
    );

    expect(gmailCalls()).toEqual([
      expect.objectContaining({
        ids: ["security-alert"],
        method: "POST",
      }),
    ]);
  });

  it("searches Google's own notices and alert subjects in the inbox", () => {
    expect(gmailSecurityAlertQuery.startsWith("in:inbox {")).toBe(true);
    expect(gmailSecurityAlertQuery).toContain("from:accounts.google.com");
    expect(gmailSecurityAlertQuery).toContain(
      'subject:"оповещение системы безопасности"'
    );
  });
});
