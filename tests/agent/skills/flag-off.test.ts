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
        "612e0584bed0ae8eca4b442534ed8374155b21720df066e0fe55660418e68d0c",
      interactive:
        "612e0584bed0ae8eca4b442534ed8374155b21720df066e0fe55660418e68d0c",
      "proactive-worker":
        "7df7cbe827c0f11e610b60414743753fe679f220f5ee6dd92690616c38571d10",
      "scheduled-report":
        "5974be0793860e5707ce2327e5f4264163730f30f3b4fb5e9d371cc5a3e6bf77",
      "scheduled-worker":
        "496190b4a60895f9d11467731830230ab015677d7f09cd0756f0ddef6b9443ff",
      telegram:
        "612e0584bed0ae8eca4b442534ed8374155b21720df066e0fe55660418e68d0c",
    },
  },
  full: {
    environment: fullDeployment,
    hashes: {
      "browser-result":
        "9e70229dd3da64f367129fc502e9bdebe3eb960184fd8af37768a1d0d9b17abc",
      interactive:
        "9e70229dd3da64f367129fc502e9bdebe3eb960184fd8af37768a1d0d9b17abc",
      "proactive-worker":
        "7df7cbe827c0f11e610b60414743753fe679f220f5ee6dd92690616c38571d10",
      "scheduled-report":
        "5974be0793860e5707ce2327e5f4264163730f30f3b4fb5e9d371cc5a3e6bf77",
      "scheduled-worker":
        "94ecaaecb110cda1ce31c91ecba2dcc7cfcd17d532ff25ca77c2d129581427c1",
      telegram:
        "9e70229dd3da64f367129fc502e9bdebe3eb960184fd8af37768a1d0d9b17abc",
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
