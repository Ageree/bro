import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ai from "ai";
import { composioToolContext } from "@tests/helpers/composio";

const calls = vi.hoisted(() => ({
  generate:
    vi.fn<() => Promise<{ output: { violatedRuleIndex: number | null } }>>(),
  rules: vi.fn<() => Promise<{ index: number; text: string }[]>>(),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof ai>()),
  generateText: calls.generate,
}));
vi.mock("@db/services/memory/records", () => ({
  listCurrentRules: calls.rules,
}));
vi.mock("@db/services/settings", () => ({
  getWorkspaceModelId: async () => "openai/gpt-5.6-sol-fast",
}));

import { outboundRuleApproval } from "./rule-approval";

function context(authenticator = "photon-imessage") {
  return {
    ...composioToolContext("unused", { authenticator, toolName: "gmail-send" }),
    approvedTools: new Set<string>(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.rules.mockResolvedValue([]);
});

describe("outbound saved rules", () => {
  it("does not add a card to the person's own action when no rule exists", async () => {
    expect(
      await outboundRuleApproval(context(), JSON.stringify({ to: "self" }))
    ).toBe("not-applicable");
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it("blocks a matching prohibition without echoing the action", async () => {
    calls.rules.mockResolvedValue([{ index: 7, text: "Never write Mum" }]);
    calls.generate.mockResolvedValue({ output: { violatedRuleIndex: 7 } });
    const result = await outboundRuleApproval(
      context(),
      JSON.stringify({ to: "mum@example.com", text: "Private note" })
    );
    expect(result).toMatchObject({ type: "denied" });
    expect(JSON.stringify(result)).toContain("saved rule #7 stops this action");
  });

  it("requires the person's card before an action from a browser report", async () => {
    expect(
      await outboundRuleApproval(
        context("browser-result"),
        JSON.stringify({ to: "mum@example.com" })
      )
    ).toBe("user-approval");
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it("fails closed when a saved rule cannot be evaluated", async () => {
    calls.rules.mockResolvedValue([{ index: 7, text: "Never write Mum" }]);
    calls.generate.mockRejectedValue(new Error("provider unavailable"));
    const result = await outboundRuleApproval(
      context(),
      JSON.stringify({ to: "mum" })
    );
    expect(result).toMatchObject({ type: "denied" });
    expect(JSON.stringify(result)).toContain("rules could not be checked");
  });
});
