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
  it("names the beta and the bug bot, and no terms or privacy", async () => {
    claim.mockResolvedValue(true);
    const lines = await context("bro_bugs_bot");
    expect(lines).toHaveLength(2);
    const text = lines.join("\n");
    expect(text).toContain("`first-contact`");
    expect(text).toContain("Бро сейчас в бете");
    expect(text).toContain("@bro_bugs_bot");
    expect(text).not.toMatch(/oferta|privacy|Условия|хранится/u);
  });

  it("says nothing of the beta when no bot is set", async () => {
    claim.mockResolvedValue(true);
    const lines = await context("");
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("бете");
  });

  it("adds nothing once the workspace has been introduced", async () => {
    claim.mockResolvedValue(false);
    expect(await context("bro_bugs_bot")).toEqual([]);
  });
});
