import type { DynamicResolveContext } from "eve/instructions";
import { describe, expect, it } from "vitest";
import {
  fullDeployment,
  stubDeployment,
  taskAgentDeployment,
  turnKinds,
} from "@tests/helpers/system-prompt";

/**
 * A deployment that signs documents in workspace-1: the kit runs in Bro's
 * own code sandbox.
 */
const signDeployment = {
  ...fullDeployment,
  ...taskAgentDeployment,
  AGENT_SANDBOX: "bro-cloudru",
  SIGN_WORKSPACES: "workspace-1",
  TASK_FILES_WORKSPACES: "workspace-1",
};

async function resolveContent(
  environment: Record<string, string>,
  context: DynamicResolveContext = turnKinds.interactive
) {
  stubDeployment(environment);
  const resolve = (await import("@agent/instructions/67-sign")).default.events[
    "turn.started"
  ];
  if (!resolve) throw new Error("The signing instructions resolve per turn.");
  return (await resolve({}, context))?.content;
}

describe("the instructions for signing documents", () => {
  it("say how to sign, in a person's turn of a listed workspace", async () => {
    const content = await resolveContent(signDeployment);
    const { instructionText } = await import("@agent/lib/skills/catalog");
    expect(content).toBe(instructionText("sign", "full"));
    expect(content).not.toContain("<!-- ");
    // The pointer is the files body's, not the full text's.
    expect(content).not.toContain("load_skill");
  });

  it.each([
    ["the flag", { ...signDeployment, SIGN_WORKSPACES: "" }],
    [
      "the workspace in the flag",
      { ...signDeployment, SIGN_WORKSPACES: "workspace-2" },
    ],
    [
      "the person's files",
      { ...signDeployment, TASK_FILES_WORKSPACES: "workspace-2" },
    ],
  ])("are none without %s", async (_case, environment) => {
    expect(await resolveContent(environment)).toBeUndefined();
  });

  it.each(["browser-result", "scheduled-worker"] as const)(
    "are none in a %s turn",
    async (kind) => {
      expect(
        await resolveContent(signDeployment, turnKinds[kind])
      ).toBeUndefined();
    }
  );

  it("are none in the skills pilot's core, where the skill holds them", async () => {
    expect(
      await resolveContent({
        ...signDeployment,
        SKILLS_WORKSPACES: "workspace-1",
      })
    ).toBeUndefined();
  });
});
