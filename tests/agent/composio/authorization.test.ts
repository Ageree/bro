import type {
  createConnectionLink as CreateConnectionLink,
  listConnectedAccounts as ListConnectedAccounts,
  pruneConnectedAccounts as PruneConnectedAccounts,
} from "@shared/composio/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createConnectionLink = vi.hoisted(() =>
  vi.fn<typeof CreateConnectionLink>()
);

vi.mock("@shared/composio/accounts", () => ({
  createConnectionLink,
  listConnectedAccounts: vi.fn<typeof ListConnectedAccounts>(),
  pruneConnectedAccounts: vi.fn<typeof PruneConnectedAccounts>(),
}));

const { composioAuthorization } =
  await import("@agent/lib/composio/authorization");

const principal = { type: "user", id: "user-1" } as const;

function signIn(callbackUrl: string) {
  const authorization = composioAuthorization({
    accounts: {
      authConfigId: () => Promise.resolve("ac_google"),
      filter: () => Promise.resolve(undefined),
    },
    authKey: "google",
    displayName: "Google",
  });
  return authorization.startAuthorization({
    callbackUrl,
    connection: { url: "https://composio.dev" },
    principal,
  });
}

describe("the Composio sign-in card", () => {
  beforeEach(() => {
    createConnectionLink.mockReset().mockResolvedValue({
      connectedAccountId: "ca_1",
      expiresAt: "2026-10-02T17:00:00.000Z",
      url: "https://connect.composio.dev/link/abc",
    });
  });

  it("sends the browser back to the site, not to the VM's loopback", async () => {
    await signIn(
      "http://127.0.0.1:4274/eve/v1/connections/google/callback/att_1/tok?x=1"
    );
    expect(createConnectionLink).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl:
          "https://example.com/eve/v1/connections/google/callback/att_1/tok?x=1",
      })
    );
  });

  it("keeps a public callback as eve made it", async () => {
    const callbackUrl =
      "https://bro-next.vercel.app/eve/v1/connections/google/callback/att_1/tok";
    await signIn(callbackUrl);
    expect(createConnectionLink).toHaveBeenCalledWith(
      expect.objectContaining({ callbackUrl })
    );
  });
});
