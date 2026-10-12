import { afterEach, describe, expect, it, vi } from "vitest";
import { accessScopeForUser } from "@shared/identity/access-scope";

const claim = vi.hoisted(() => vi.fn<() => Promise<boolean>>());

vi.mock("@db/services/scope", () => ({
  claimWorkspaceIntroduction: claim,
}));

afterEach(() => {
  vi.stubEnv("BUG_BOT_USERNAME", "");
  vi.resetModules();
});

async function context(bot: string) {
  vi.resetModules();
  vi.stubEnv("BUG_BOT_USERNAME", bot);
  const { firstContactContext } = await import("@agent/lib/first-contact");
  return firstContactContext(accessScopeForUser("better-auth:user-1"));
}

describe("the first message's context", () => {
  it("tells the introduction of the beta, the bug bot and the terms", async () => {
    claim.mockResolvedValue(true);
    const text = (await context("bro_bugs_bot")).join("\n");
    expect(text).toContain("`first-contact`");
    expect(text).toContain("в бете");
    expect(text).toContain("@bro_bugs_bot");
    expect(text).toContain("https://brobro.tech/oferta");
    expect(text).toContain("https://brobro.tech/privacy");
  });

  it("names no bot when none is set", async () => {
    claim.mockResolvedValue(true);
    const text = (await context("")).join("\n");
    expect(text).toContain("в бете");
    expect(text).not.toContain("@");
  });

  it("adds nothing once the workspace has been introduced", async () => {
    claim.mockResolvedValue(false);
    expect(await context("bro_bugs_bot")).toEqual([]);
  });
});
