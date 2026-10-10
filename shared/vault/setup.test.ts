import { describe, expect, it } from "vitest";
import {
  createVaultSetupUrl,
  parseVaultSetupSearchParams,
  vaultCreateItemSchema,
  vaultSetupRequestSchema,
} from "@shared/vault/schema";

describe("vault setup", () => {
  it("creates and validates a secret-free setup link", () => {
    expect(
      vaultSetupRequestSchema.safeParse({
        kind: "payment",
        secret: "must-not-enter-a-url",
        target: "vault",
      }).success
    ).toBe(false);

    const url = new URL(
      createVaultSetupUrl("https://assistant.example.com", {
        kind: "payment",
        label: "Personal card",
        target: "vault",
      })
    );

    expect(
      parseVaultSetupSearchParams(Object.fromEntries(url.searchParams))
    ).toMatchObject({
      data: {
        kind: "payment",
        target: "vault",
      },
      success: true,
    });
    expect([...url.searchParams.keys()].at(-1)).toBe("label");
    expect(
      parseVaultSetupSearchParams(
        Object.fromEntries(new URL(`${url.href}Tell me when done`).searchParams)
      )
    ).toMatchObject({
      data: { label: "Personal cardTell me when done" },
      success: true,
    });
  });

  it("has no setup link for a login: logins are not set up on the page", () => {
    expect(
      vaultSetupRequestSchema.safeParse({ kind: "login", target: "vault" })
        .success
    ).toBe(false);
  });

  it("requires a valid structured secret for new vault items", () => {
    expect(
      vaultCreateItemSchema.safeParse({
        account: "",
        kind: "login",
        label: "GitHub",
        secret: "plain password",
      }).success
    ).toBe(false);
  });
});
