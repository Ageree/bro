import type { ToolContext } from "eve/tools";
import { describe, expect, it } from "vitest";
import { vaultSetupRequestSchema } from "@shared/vault/schema";
import { accessScopeForUser } from "@shared/identity/access-scope";

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

describe("request_vault_setup", () => {
  it("links to the vault form for a card, an address or a contact", async () => {
    const result = await requestVaultSetup.execute(
      { kind: "payment", target: "vault" },
      toolContext()
    );

    const text = JSON.stringify(result);
    expect(text).toContain("Секрет в чат не присылай");
    expect(text).toContain("/vault?setup=vault&kind=payment");
  });

  it("makes no link for a login: logins have no page", () => {
    expect(
      vaultSetupRequestSchema.safeParse({ kind: "login", target: "vault" })
        .success
    ).toBe(false);
  });
});
