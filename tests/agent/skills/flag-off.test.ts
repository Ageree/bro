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

/** Every kind of turn's prompt in a deployment, in `turnKinds`' order. */
async function promptsOf(environment: Record<string, string>) {
  stubDeployment(environment);
  return Promise.all(
    Object.values(turnKinds).map((context) => systemPrompt(context))
  );
}

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
        "6d88b2b762b2df61f8f4155ed13108bdecddd929adaac262be4545ca4f7a8dd1",
      interactive:
        "6d88b2b762b2df61f8f4155ed13108bdecddd929adaac262be4545ca4f7a8dd1",
      "proactive-worker":
        "7df7cbe827c0f11e610b60414743753fe679f220f5ee6dd92690616c38571d10",
      "scheduled-report":
        "938731874072f944e329e0f97a258a97b46d8c0ce648c7700e0905759e427723",
      "scheduled-worker":
        "4d2af5e41a2254d3d8a439f9084d7befac2776145ca60bf3fb1f4831fdea7e2a",
      telegram:
        "6d88b2b762b2df61f8f4155ed13108bdecddd929adaac262be4545ca4f7a8dd1",
    },
  },
  full: {
    environment: fullDeployment,
    hashes: {
      "browser-result":
        "5698e48ca427932c386bf8e2916e5fd236a28d3c232e599740b945e849548552",
      interactive:
        "5698e48ca427932c386bf8e2916e5fd236a28d3c232e599740b945e849548552",
      "proactive-worker":
        "7df7cbe827c0f11e610b60414743753fe679f220f5ee6dd92690616c38571d10",
      "scheduled-report":
        "938731874072f944e329e0f97a258a97b46d8c0ce648c7700e0905759e427723",
      "scheduled-worker":
        "b7c516ecd20c98fe2b9260fdd63ac0b3c67455298db3f75ce19f78351a81728c",
      telegram:
        "5698e48ca427932c386bf8e2916e5fd236a28d3c232e599740b945e849548552",
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

  it("add the rules for signing only where the workspace signs", async () => {
    // Bro's own code sandbox runs the kit that stamps.
    const agent = {
      ...fullDeployment,
      ...taskAgentDeployment,
      AGENT_SANDBOX: "bro-cloudru",
    };
    const files = { ...agent, TASK_FILES_WORKSPACES: "workspace-1" };
    // Not without the files, and not for another workspace.
    expect(await promptsOf({ ...agent, SIGN_WORKSPACES: "*" })).toEqual(
      await promptsOf(agent)
    );
    const before = await promptsOf(files);
    expect(
      await promptsOf({ ...files, SIGN_WORKSPACES: "workspace-2" })
    ).toEqual(before);
    const after = await promptsOf({ ...files, SIGN_WORKSPACES: "workspace-1" });
    const { instructionText } = await import("@agent/lib/skills/catalog");
    const sign = instructionText("sign", "full");
    // The block in a person's turns, and nothing else: whether to ask is
    // the tool's (`sign_document`).
    expect(
      Object.keys(turnKinds).filter(
        (_kind, index) => after[index] !== before[index]
      )
    ).toEqual(["interactive", "telegram"]);
    expect(after.map((prompt) => prompt.replace(`\n\n${sign}`, ""))).toEqual(
      before
    );
  });

  it("stay so on the Gateway, where nobody is in the pilot", async () => {
    const { environment, hashes } = deployments.bare;
    expect(
      await promptHashes({ ...environment, SKILLS_WORKSPACES: "*" })
    ).toEqual(hashes);
  });
});
