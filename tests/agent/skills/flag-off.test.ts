import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fullDeployment,
  stubDeployment,
  systemPrompt,
  taskAgentDeployment,
  turnKinds,
} from "@tests/helpers/system-prompt";

// What the resolvers read of a workspace: no limit, Moscow, «ты», and
// other chats.
vi.mock("@db/services/spending", () => ({
  listSpendEntries: async () => [],
  readSpendLimit: async () => undefined,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: async () => "Europe/Moscow",
}));
vi.mock("@db/services/settings", () => ({
  getFormOfAddress: async () => ({ kind: "ty" }),
}));
vi.mock("@db/services/chats", () => ({
  hasOtherConversations: async () => true,
}));

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T09:41:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Deployments whose instructions differ: everything set up, and nothing.
 * Each comes with its prompts' hashes from before skills (2 October 2026):
 * outside the pilot the marked files must read exactly as they did. A
 * change to the instructions themselves changes these on purpose.
 */
const deployments = {
  bare: {
    environment: {},
    hashes: {
      "browser-result":
        "cbb70b187d1535f6fc53048abace5c4263e80d8ebfd184c81bfb31ed3b336963",
      interactive:
        "cbb70b187d1535f6fc53048abace5c4263e80d8ebfd184c81bfb31ed3b336963",
      "proactive-worker":
        "7df7cbe827c0f11e610b60414743753fe679f220f5ee6dd92690616c38571d10",
      "scheduled-report":
        "938731874072f944e329e0f97a258a97b46d8c0ce648c7700e0905759e427723",
      "scheduled-worker":
        "4fc0b8a5b6e49ebaeb1fb5f669f20f6131e8848aade4375a9e93c2331982035e",
      telegram:
        "cbb70b187d1535f6fc53048abace5c4263e80d8ebfd184c81bfb31ed3b336963",
    },
  },
  full: {
    environment: fullDeployment,
    hashes: {
      "browser-result":
        "f77d8e5ef3f36af4b604f4134169b405b3de8273e1d0ad16466dc2c3d8e605b8",
      interactive:
        "f77d8e5ef3f36af4b604f4134169b405b3de8273e1d0ad16466dc2c3d8e605b8",
      "proactive-worker":
        "7df7cbe827c0f11e610b60414743753fe679f220f5ee6dd92690616c38571d10",
      "scheduled-report":
        "938731874072f944e329e0f97a258a97b46d8c0ce648c7700e0905759e427723",
      "scheduled-worker":
        "03c3d49d38ce41c7f89527c758535519034847140cc9fa84ffa2143ee01aafbb",
      telegram:
        "f77d8e5ef3f36af4b604f4134169b405b3de8273e1d0ad16466dc2c3d8e605b8",
    },
  },
};

async function promptHashes(environment: Record<string, string>) {
  stubDeployment(environment);
  return Object.fromEntries(
    await Promise.all(
      Object.entries(turnKinds).map(
        async ([kind, context]) =>
          [kind, sha256(await systemPrompt(context))] as const
      )
    )
  );
}

describe("instructions outside the skills pilot", () => {
  it.each(Object.entries(deployments))(
    "are byte for byte what they were before skills, in every kind of turn (%s deployment)",
    async (_name, { environment, hashes }) => {
      expect(await promptHashes(environment)).toEqual(hashes);
    }
  );

  it("stay so when the pilot names another workspace", async () => {
    const { environment, hashes } = deployments.full;
    expect(
      await promptHashes({ ...environment, SKILLS_WORKSPACES: "workspace-2" })
    ).toEqual(hashes);
  });

  it("stay so in the pilot for every turn but the interactive", async () => {
    const { environment, hashes } = deployments.full;
    const piloted = await promptHashes({
      ...environment,
      SKILLS_WORKSPACES: "*",
    });
    for (const kind of [
      "proactive-worker",
      "scheduled-report",
      "scheduled-worker",
    ] as const) {
      expect(piloted[kind]).toBe(hashes[kind]);
    }
    // The interactive turns of the pilot read the core instead.
    for (const kind of ["browser-result", "interactive", "telegram"] as const) {
      expect(piloted[kind]).not.toBe(hashes[kind]);
    }
  });

  it("stay so where the person's files do not reach the task agent", async () => {
    const { environment, hashes } = deployments.full;
    expect(
      await promptHashes({ ...environment, TASK_FILES_WORKSPACES: "*" })
    ).toEqual(hashes);
    // With the task agent, but for another workspace.
    const agent = { ...environment, ...taskAgentDeployment };
    expect(
      await promptHashes({ ...agent, TASK_FILES_WORKSPACES: "workspace-2" })
    ).toEqual(await promptHashes(agent));
  });

  it("add the rules for files to a person's turns, where they reach the task agent", async () => {
    stubDeployment({ ...fullDeployment, ...taskAgentDeployment });
    const agent = await systemPrompt(turnKinds.interactive);
    stubDeployment({
      ...fullDeployment,
      ...taskAgentDeployment,
      TASK_FILES_WORKSPACES: "workspace-1",
    });
    const { instructionText } = await import("@agent/lib/skills/catalog");
    const files = instructionText("task-files", "full");
    const heading = "# Файлы человека и тяжёлая работа";
    expect(files.startsWith(heading)).toBe(true);
    // One block more, and nothing else changed.
    const prompts = await Promise.all(
      Object.values(turnKinds).map((context) => systemPrompt(context))
    );
    const byKind = new Map(
      Object.keys(turnKinds).map((kind, index) => [kind, prompts[index] ?? ""])
    );
    for (const kind of ["interactive", "telegram"]) {
      const prompt = byKind.get(kind) ?? "";
      expect(prompt).toContain(files);
      expect(prompt.replace(`\n\n${files}`, "")).toBe(agent);
    }
    for (const kind of [
      "browser-result",
      "proactive-worker",
      "scheduled-report",
      "scheduled-worker",
    ]) {
      expect(byKind.get(kind)).not.toContain(heading);
    }
  });

  it("stay so on the Gateway, where nobody is in the pilot", async () => {
    const { environment, hashes } = deployments.bare;
    expect(
      await promptHashes({ ...environment, SKILLS_WORKSPACES: "*" })
    ).toEqual(hashes);
  });
});
