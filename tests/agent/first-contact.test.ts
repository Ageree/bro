import { afterEach, describe, expect, it, vi } from "vitest";
import { accessScopeForUser } from "@shared/identity/access-scope";

const mocks = vi.hoisted(() => ({
  claim: vi.fn<() => Promise<boolean>>(),
  target: vi.fn<() => { botToken: string; ownerChatId: string } | undefined>(),
}));

vi.mock("@db/services/scope", () => ({
  claimWorkspaceIntroduction: mocks.claim,
}));
vi.mock("@agent/lib/bug-bot/target", () => ({
  bugBotTarget: mocks.target,
}));

const botOn = { botToken: "bug-bot-token", ownerChatId: "1" };

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
  it("names the beta and the bug bot while the bot is on, and no terms or privacy", async () => {
    mocks.claim.mockResolvedValue(true);
    mocks.target.mockReturnValue(botOn);
    const lines = await context("bro_bugs_bot");
    expect(lines).toHaveLength(2);
    const text = lines.join("\n");
    expect(text).toContain("`first-contact`");
    expect(text).toContain("Бро сейчас в бете");
    expect(text).toContain("@bro_bugs_bot");
    expect(text).not.toMatch(/oferta|privacy|Условия|хранится/u);
  });

  it("says nothing of the beta when the bot is named but off", async () => {
    mocks.claim.mockResolvedValue(true);
    mocks.target.mockReturnValue(undefined);
    const lines = await context("bro_bugs_bot");
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("бете");
  });

  it("says nothing of the beta when no bot is named", async () => {
    mocks.claim.mockResolvedValue(true);
    mocks.target.mockReturnValue(botOn);
    const lines = await context("");
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("бете");
  });

  it("adds nothing once the workspace has been introduced", async () => {
    mocks.claim.mockResolvedValue(false);
    mocks.target.mockReturnValue(botOn);
    expect(await context("bro_bugs_bot")).toEqual([]);
  });
});
