import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getGoogleWorkspaceAccess } from "@db/services/settings";
import {
  composioToolContext,
  type FakeComposio,
  fakeComposio,
} from "@tests/helpers/composio";

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: settings.access,
}));

import { contactsSearch } from "@agent/tools/contacts";

/** Лёша as Google Contacts holds him: a mobile number and nothing else. */
const lesha = {
  person: {
    names: [{ displayName: "Лёша блейр" }],
    phoneNumbers: [{ type: "MOBILE", value: "+79117317917" }],
    resourceName: "people/c1",
  },
};

const irina = {
  person: {
    emailAddresses: [{ value: "irina@example.com" }],
    names: [{ displayName: "Ирина Павловна" }],
    resourceName: "people/c2",
  },
};

let composio: FakeComposio;

beforeEach(() => {
  vi.clearAllMocks();
  settings.access.mockResolvedValue("full");
  composio = fakeComposio();
  composio.connect({ id: "ca_google", toolkit: "googlesuper" });
  composio.proxy.mockImplementation(({ url }) => ({
    data: url.searchParams.get("query") ? { results: [lesha, irina] } : {},
  }));
});

async function search() {
  const result = await contactsSearch.execute(
    { pageSize: 10, query: "Лёша" },
    composioToolContext("ca_google")
  );
  if (Symbol.asyncIterator in result) {
    throw new Error("contacts-search returns one result.");
  }
  return result;
}

describe("contacts and the ways to message them", () => {
  it("offers email only to a contact with an address, and never SMS or Telegram", async () => {
    const result = await search();

    expect(result.contacts).toEqual([
      { ...lesha, canMessageVia: [] },
      {
        ...irina,
        canMessageVia: ["email to irina@example.com (gmail-send)"],
      },
    ]);
    expect(result.messaging).toContain(
      "You cannot send an SMS or a Telegram, WhatsApp or iMessage message"
    );
    expect(result.messaging).toContain(
      "give the ready text for the person to forward"
    );
    expect(result.messaging).not.toContain("read-only");
  });

  it("adds Slack only when the person's Slack is connected", async () => {
    composio.connect({ authConfigId: "ac_slack", toolkit: "slack" });

    const result = await search();

    expect(result.contacts.map((contact) => contact.canMessageVia)).toEqual([
      [
        "Slack to Лёша блейр (slack-send-message), if they are in the person's Slack",
      ],
      [
        "email to irina@example.com (gmail-send)",
        "Slack to irina@example.com (slack-send-message), if they are in the person's Slack",
      ],
    ]);
  });

  it("offers no email while Google is connected read-only", async () => {
    settings.access.mockResolvedValue("read_only");
    composio.connect({
      authConfigId: "ac_google_read_only",
      id: "ca_google_read",
      toolkit: "googlesuper",
    });

    const result = await contactsSearch.execute(
      { pageSize: 10, query: "Ирина" },
      composioToolContext("ca_google_read")
    );
    if (Symbol.asyncIterator in result) {
      throw new Error("contacts-search returns one result.");
    }

    expect(result.contacts.map((contact) => contact.canMessageVia)).toEqual([
      [],
      [],
    ]);
    expect(result.messaging).toContain("Google is connected read-only");
  });
});
