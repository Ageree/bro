import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  composioToolContext,
  type FakeComposio,
  fakeComposio,
} from "@tests/helpers/composio";

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => "full",
}));

import { searchGmail } from "@agent/lib/google-workspace/gmail";

let composio: FakeComposio;
let inFlight: number;
let mostInFlight: number;
let release: (() => void)[];

/** Holds each message read until the test lets it go. */
function heldReads(found: number) {
  composio.proxy.mockImplementation(async ({ url }) => {
    if (url.pathname.endsWith("/messages")) {
      return {
        data: {
          messages: Array.from({ length: found }, (_, index) => ({
            id: `${url.searchParams.get("q") ?? ""}-${String(index)}`,
          })),
        },
      };
    }
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise<void>((resolve) => release.push(resolve));
    inFlight -= 1;
    return { data: { id: url.pathname.split("/").at(-1) } };
  });
}

async function settle() {
  for (let round = 0; round < 50; round += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Lets each held read reach the fake.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  composio = fakeComposio();
  composio.connect({ id: "ca_google", toolkit: "googlesuper" });
  inFlight = 0;
  mostInFlight = 0;
  release = [];
});

describe("gmail-search message reads", () => {
  it("reads a default page of ten in one wave", async () => {
    heldReads(10);
    const search = searchGmail(composioToolContext("ca_google"), "a", 10);
    await settle();

    expect(inFlight).toBe(10);
    for (const resolve of release.splice(0)) resolve();
    await expect(search).resolves.toHaveLength(10);
  });

  it("starts a waiting read as soon as one ends and keeps the order", async () => {
    heldReads(12);
    const search = searchGmail(composioToolContext("ca_google"), "a", 12);
    await settle();
    expect(inFlight).toBe(10);

    release.shift()?.();
    await settle();
    expect(inFlight).toBe(10);

    while (release.length > 0) {
      for (const resolve of release.splice(0)) resolve();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Lets the waiting reads start.
      await settle();
    }
    const messages = await search;
    expect(messages.map(({ id }) => id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `a-${String(index)}`)
    );
  });

  it("keeps two searches of one account within ten reads together", async () => {
    heldReads(10);
    const ctx = composioToolContext("ca_google");
    const searches = Promise.all([
      searchGmail(ctx, "a", 10),
      searchGmail(ctx, "b", 10),
    ]);
    await settle();
    expect(inFlight).toBe(10);

    while (release.length > 0) {
      for (const resolve of release.splice(0)) resolve();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Lets the waiting reads start.
      await settle();
    }
    const [first, second] = await searches;
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(mostInFlight).toBe(10);
  });
});
