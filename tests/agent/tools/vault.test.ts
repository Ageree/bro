import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessScopeForUser } from "@shared/identity/access-scope";

const readVaultItems = vi.hoisted(() =>
  vi.fn<() => Promise<{ account: string; id: string; kind: string }[]>>(() =>
    Promise.resolve([])
  )
);
vi.mock("@db/services/vault", () => ({ readVaultItems }));

import { requestVaultSetup } from "@agent/tools/vault";

const principalId = "better-auth:alice";

function toolContext() {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: () => {
      throw new Error("The tool does not use a sandbox.");
    },
    getSkill: () => {
      throw new Error("The tool does not use a skill.");
    },
    getToken: () => {
      throw new Error("The tool does not use an inline token provider.");
    },
    requireAuth: (): never => {
      throw new Error("The tool does not require an inline token provider.");
    },
    session: {
      auth: {
        current: {
          attributes: {
            conversationChannel: "eve",
            workspaceId: accessScopeForUser(principalId).workspaceId,
          },
          authenticator: "authjs",
          issuer: "open-instinct",
          principalId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "request_vault_setup",
  } satisfies ToolContext;
}

const gosuslugi = {
  identifierType: "phone" as const,
  kind: "login" as const,
  label: "Госуслуги",
  origin: "https://www.gosuslugi.ru",
  target: "vault" as const,
};

describe("request_vault_setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readVaultItems.mockResolvedValue([]);
  });

  it("links to the vault form when the site has no saved login", async () => {
    const result = await requestVaultSetup.execute(gosuslugi, toolContext());

    const text = JSON.stringify(result);
    expect(text).toContain("Секрет в чат не присылай");
    expect(text).toContain("/vault?setup=vault&kind=login");
    expect(result).not.toHaveProperty("alreadySaved");
  });

  it("says so when the vault already signs in to that site", async () => {
    // RU 24.09, d06: the run had the Госуслуги login bound, and the person
    // still heard it was missing, twice.
    readVaultItems.mockResolvedValue([
      {
        account: "www.gosuslugi.ru · +7•••76",
        id: "login-1",
        kind: "login",
      },
    ]);

    const result = await requestVaultSetup.execute(gosuslugi, toolContext());

    expect(result).toHaveProperty("alreadySaved", true);
    expect(JSON.stringify(result)).toContain(
      "do not tell the user their login is missing"
    );
    expect(result).not.toHaveProperty("message");
  });
});
