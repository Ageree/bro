import { beforeEach, describe, expect, it, vi } from "vitest";
import type { readAgentMailbox } from "@db/services/agent-mailboxes";
import type { listVaultItems, readVaultSecret } from "@db/services/vault";
import type { AccessScope } from "@shared/identity/access-scope";
import { serializeLoginVaultPayload } from "@shared/vault/schema";
import { listBroLoginIds, revealBroLogin } from "@db/services/bro-logins";

const mocks = vi.hoisted(() => ({
  listVaultItems: vi.fn<typeof listVaultItems>(),
  readAgentMailbox: vi.fn<typeof readAgentMailbox>(),
  readVaultSecret: vi.fn<typeof readVaultSecret>(),
}));
vi.mock("@db/services/agent-mailboxes", () => ({
  readAgentMailbox: mocks.readAgentMailbox,
}));
vi.mock("@db/services/vault", () => ({
  listVaultItems: mocks.listVaultItems,
  readVaultSecret: mocks.readVaultSecret,
}));

const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };
const address = "Quiet.Fox42@agentmail.to";

function login(email: string, password = "Gen3rated!Pass") {
  return serializeLoginVaultPayload({
    authentication: { password, type: "password" },
    identifier: { type: "email", value: email },
    kind: "login",
    origin: "https://www.inaturalist.org",
    version: 2,
  });
}

function item(id: string, kind: "login" | "payment", account: string) {
  return {
    account,
    createdAt: new Date().toISOString(),
    id,
    kind,
    label: id,
    updatedAt: new Date().toISOString(),
  };
}

/** Alice's vault: Bro's login, her own, one with a look-alike hint, a card. */
const secrets = new Map([
  ["bro", login("quiet.fox42@agentmail.to")],
  ["own", login("alice@example.com", "her-own-password")],
  ["lookalike", login("quentin@agentmail.to")],
]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readAgentMailbox.mockImplementation(async (scope: AccessScope) =>
    scope.workspaceId === alice.workspaceId
      ? {
          createdAt: new Date(),
          displayName: "Bro",
          email: address,
          inboxId: "inbox-1",
          workspaceId: alice.workspaceId,
        }
      : undefined
  );
  mocks.listVaultItems.mockImplementation(async (scope: AccessScope) =>
    scope.workspaceId === alice.workspaceId
      ? [
          item("bro", "login", "www.inaturalist.org · q•••@agentmail.to"),
          item("own", "login", "www.inaturalist.org · a•••@example.com"),
          item("lookalike", "login", "site.example · q•••@agentmail.to"),
          item("card", "payment", "Visa · •••• 4242"),
        ]
      : []
  );
  mocks.readVaultSecret.mockImplementation(async (scope, id) =>
    scope.workspaceId === alice.workspaceId ? secrets.get(id) : undefined
  );
});

describe("Bro's own logins in the vault", () => {
  it("reads back only a login whose email is the workspace's mailbox", async () => {
    await expect(revealBroLogin(alice, "bro")).resolves.toEqual({
      email: "quiet.fox42@agentmail.to",
      password: "Gen3rated!Pass",
    });
  });

  it("refuses the person's own login, another email, a card and a stranger", async () => {
    await expect(revealBroLogin(alice, "own")).resolves.toBeUndefined();
    await expect(revealBroLogin(alice, "lookalike")).resolves.toBeUndefined();
    await expect(revealBroLogin(alice, "card")).resolves.toBeUndefined();
    await expect(revealBroLogin(alice, "missing")).resolves.toBeUndefined();
    // Another workspace never reaches Alice's item, even by its id.
    await expect(revealBroLogin(bob, "bro")).resolves.toBeUndefined();
    expect(mocks.readVaultSecret).not.toHaveBeenCalledWith(alice, "card");
  });

  it("refuses everything when the workspace has no mailbox", async () => {
    mocks.readAgentMailbox.mockResolvedValue(undefined);

    await expect(revealBroLogin(alice, "bro")).resolves.toBeUndefined();
    await expect(listBroLoginIds(alice)).resolves.toEqual([]);
    expect(mocks.readVaultSecret).not.toHaveBeenCalled();
  });

  it("lists which rows are Bro's without decrypting the person's logins", async () => {
    await expect(listBroLoginIds(alice)).resolves.toEqual(["bro"]);
    expect(
      mocks.readVaultSecret.mock.calls.map(([, id]) => id).toSorted()
    ).toEqual(["bro", "lookalike"]);
    await expect(listBroLoginIds(bob)).resolves.toEqual([]);
  });
});
