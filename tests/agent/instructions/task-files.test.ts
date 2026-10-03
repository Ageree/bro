import type { DynamicResolveContext } from "eve/instructions";
import { describe, expect, it } from "vitest";
import {
  fullDeployment,
  stubDeployment,
  taskAgentDeployment,
  turnKinds,
} from "@tests/helpers/system-prompt";

/** A deployment whose task agent gets the person's files in workspace-1. */
const filesDeployment = {
  ...fullDeployment,
  ...taskAgentDeployment,
  TASK_FILES_WORKSPACES: "workspace-1",
};

async function resolveContent(
  environment: Record<string, string>,
  context: DynamicResolveContext = turnKinds.interactive
) {
  stubDeployment(environment);
  const resolve = (await import("@agent/instructions/66-task-files")).default
    .events["turn.started"];
  if (!resolve) throw new Error("The files' instructions resolve per turn.");
  return (await resolve({}, context))?.content;
}

describe("the instructions for the person's files", () => {
  it.each(["interactive", "telegram"] as const)(
    "say how files reach the task agent, in a person's turn of a listed workspace (%s)",
    async (kind) => {
      const content = await resolveContent(filesDeployment, turnKinds[kind]);
      expect(content).toMatch(/^# Файлы человека и тяжёлая работа\n/u);
      expect(content).toContain("перепиши каждый путь дословно");
      expect(content).not.toContain("<!-- ");
    }
  );

  it.each([
    ["the flag", { ...fullDeployment, ...taskAgentDeployment }],
    [
      "the workspace in the flag",
      { ...filesDeployment, TASK_FILES_WORKSPACES: "workspace-2" },
    ],
    ["the task agent", { ...fullDeployment, TASK_FILES_WORKSPACES: "*" }],
    // The task agent's pilot names the workspace only by the owner's email.
    [
      "the workspace's id in the task agent's pilot",
      { ...filesDeployment, SANDBOX_WORKSPACES: "owner@example.com" },
    ],
  ])("are none without %s", async (_case, environment) => {
    expect(await resolveContent(environment)).toBeUndefined();
  });

  it.each([
    "browser-result",
    "proactive-worker",
    "scheduled-report",
    "scheduled-worker",
  ] as const)("are none in a %s turn", async (kind) => {
    expect(
      await resolveContent(filesDeployment, turnKinds[kind])
    ).toBeUndefined();
  });

  it("are none in the skills pilot's core, where the skill holds them", async () => {
    expect(
      await resolveContent({
        ...filesDeployment,
        SKILLS_WORKSPACES: "workspace-1",
      })
    ).toBeUndefined();
  });
});
