import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function directories(directory: string) {
  return readdirSync(directory)
    .filter((entry) => statSync(join(directory, entry)).isDirectory())
    .toSorted();
}

function files(directory: string) {
  return readdirSync(directory)
    .filter((entry) => statSync(join(directory, entry)).isFile())
    .toSorted();
}

describe("source layout", () => {
  it("keeps the Eve agent and Next route tree at the repository root", () => {
    expect(existsSync("agent/agent.ts")).toBe(true);
    expect(existsSync("agent/instructions.md")).toBe(true);
    expect(existsSync("app/layout.tsx")).toBe(true);
    expect(existsSync("app/(public)/page.tsx")).toBe(true);
    expect(
      existsSync("app/(authenticated)/workspace/(overview)/page.tsx")
    ).toBe(true);
    expect(existsSync("app/(authenticated)/chat/(new)/page.tsx")).toBe(true);
    expect(existsSync("proxy.ts")).toBe(true);
    expect(existsSync("src")).toBe(false);
  });

  it("keeps cross-boundary contracts explicitly owned", () => {
    expect(directories("web")).toEqual(["auth", "components", "hooks", "trpc"]);
    expect(files("web")).toEqual([]);
    expect(directories("shared")).toEqual([
      "browser",
      "calendar",
      "chat",
      "composio",
      "costs",
      "environment",
      "google-workspace",
      "identity",
      "memory",
      "model",
      "object-storage",
      "photon",
      "schedules",
      "spending",
      "subscriptions",
      "user-profile",
      "vault",
      "workstreams",
    ]);
    expect(files("shared")).toEqual([]);
    expect(existsSync("shared/environment/env.ts")).toBe(true);
    expect(existsSync("db/services/installation-secrets.ts")).toBe(true);
    // The one declared subagent is the task agent with its code sandbox
    // (sandbox/README.md); browser work stays the `browser_task` tool.
    expect(directories("agent/subagents")).toEqual(["task"]);
  });
});
