import { describe, expect, it, vi } from "vitest";
import { accessScopeForUser } from "@shared/identity/access-scope";

const mocks = vi.hoisted(() => ({
  claim: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("@db/services/scope", () => ({
  claimWorkspaceIntroduction: mocks.claim,
}));

import { firstContactContext } from "@agent/lib/first-contact";

const context = async () =>
  firstContactContext(accessScopeForUser("better-auth:user-1"));

describe("the first message's context", () => {
  it("names the beta and the owner's Telegram for faults, and no terms or privacy", async () => {
    mocks.claim.mockResolvedValue(true);
    const lines = await context();
    expect(lines).toHaveLength(2);
    const text = lines.join("\n");
    expect(text).toContain("`first-contact`");
    expect(text).toContain("Бро сейчас в бете");
    expect(text).toContain("@kapital0");
    expect(text).not.toMatch(/oferta|privacy|Условия|хранится/u);
  });

  it("adds nothing once the workspace has been introduced", async () => {
    mocks.claim.mockResolvedValue(false);
    expect(await context()).toEqual([]);
  });
});
