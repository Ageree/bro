import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  getWorkspaceModelId: vi.fn<() => Promise<string>>(() =>
    Promise.resolve("deepseek/deepseek-v4.1")
  ),
  modelSelection: vi.fn<(modelId: string) => string>((modelId) => modelId),
  offlineRefusal: vi.fn<() => "none" | "owed" | "unchecked">(() => "none"),
  taskAgentPilot: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
}));

vi.mock("@db/services/settings", () => ({
  getWorkspaceModelId: services.getWorkspaceModelId,
}));
vi.mock("@agent/lib/model/selection", () => ({
  modelSelection: services.modelSelection,
}));
vi.mock("@agent/lib/sandbox/offline", () => ({
  offlineRefusal: services.offlineRefusal,
}));
vi.mock("@agent/lib/sandbox/pilot", () => ({
  taskAgentPilot: services.taskAgentPilot,
}));

import taskAgent from "@agent/subagents/task/agent";

function stepContext() {
  return {
    session: {
      auth: {
        current: {
          attributes: {
            workspaceId: "personal:0123456789abcdef0123456789abcdef",
          },
          authenticator: "telegram-webhook",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
    },
  };
}

async function resolveStep() {
  const resolve = taskAgent.model.events["step.started"];
  // SAFETY: the resolver reads the session's caller only.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial context stands in for eve's.
  const ctx = stepContext() as never;
  return await resolve?.({}, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  services.offlineRefusal.mockReturnValue("none");
});

describe("the task agent's model", () => {
  it("runs a step of a task agent that owes no mark", async () => {
    expect(await resolveStep()).toBe("deepseek/deepseek-v4.1");
  });

  it("refuses every step while its sandbox owes the mark or its checks could not be read", async () => {
    // Owed: the tool router would still let this sandbox reach the web.
    // Unchecked: whether the person sent it is unknown, so no web either.
    for (const refusal of ["owed", "unchecked"] as const) {
      services.offlineRefusal.mockReturnValue(refusal);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each refusal is checked in turn.
      await expect(resolveStep()).rejects.toThrow(/taken off the web/u);
    }
    expect(services.modelSelection).not.toHaveBeenCalled();
  });
});
