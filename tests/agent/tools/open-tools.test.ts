import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as StepPilot from "@agent/lib/step-context/pilot";
import { catalogContext } from "@tests/helpers/tool-catalog";

const stepPilot = vi.hoisted(() => ({
  ofCaller: vi.fn<typeof StepPilot.stepContextPilotOfCaller>(),
}));

vi.mock("@agent/lib/step-context/pilot", async (importOriginal) => ({
  ...(await importOriginal<typeof StepPilot>()),
  stepContextPilotOfCaller: stepPilot.ofCaller,
}));

const pilots = {
  OPENROUTER_API_KEY: "test-openrouter-key",
  SKILLS_WORKSPACES: "*",
  TOOL_ROUTER_MODE: "on",
  TOOL_ROUTER_WORKSPACES: "workspace-1",
};

/** The phone's pilot for the workspace, with what it needs. */
const phonePilot = {
  ELEVENLABS_API_KEY: "elevenlabs-test-key",
  EVE_SCHEDULES: "on",
  MTS_EXOLVE_API_KEY: "exolve-test-key",
  PHONE_AGENT_ID: "agent-test",
  PHONE_INIT_SECRET: "i".repeat(32),
  PHONE_WEBHOOK_SECRET: "w".repeat(32),
  PHONE_WORKSPACES: "workspace-1",
};

beforeEach(() => {
  stepPilot.ofCaller.mockReset();
  stepPilot.ofCaller.mockResolvedValue(true);
});

afterEach(() => {
  for (const name of Object.keys({ ...pilots, ...phonePilot })) {
    vi.stubEnv(name, "");
  }
});

async function resolve(
  environment: Partial<typeof pilots & typeof phonePilot>,
  kind: Parameters<typeof catalogContext>[0] = "web"
) {
  for (const name of Object.keys(phonePilot)) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(environment)) {
    if (name in phonePilot) vi.stubEnv(name, value);
  }
  vi.stubEnv("OPENROUTER_API_KEY", environment.OPENROUTER_API_KEY ?? "");
  vi.stubEnv("SKILLS_WORKSPACES", environment.SKILLS_WORKSPACES ?? "");
  vi.stubEnv("TOOL_ROUTER_MODE", environment.TOOL_ROUTER_MODE ?? "");
  vi.stubEnv(
    "TOOL_ROUTER_WORKSPACES",
    environment.TOOL_ROUTER_WORKSPACES ?? ""
  );
  vi.resetModules();
  const tool = (await import("@agent/tools/open_tools")).default;
  return tool.events["step.started"]?.(
    { data: { stepIndex: 0, turnId: "turn-1" }, type: "step.started" },
    catalogContext(kind)
  );
}

describe("open_tools", { timeout: 60_000 }, () => {
  it("is offered in a person's turn of the router's pilot, when it is on", async () => {
    const tool = await resolve(pilots);
    expect(tool).not.toBeNull();
    expect(stepPilot.ofCaller).toHaveBeenCalledOnce();
  });

  it("is not offered in the shadow, without the skills or the step pilot", async () => {
    expect(await resolve({ ...pilots, TOOL_ROUTER_MODE: "shadow" })).toBeNull();
    expect(await resolve({ ...pilots, SKILLS_WORKSPACES: "" })).toBeNull();
    expect(await resolve(pilots, "scheduled-worker")).toBeNull();
    stepPilot.ofCaller.mockResolvedValue(false);
    expect(await resolve(pilots)).toBeNull();
  });

  it("asks no lookup of a workspace outside the pilot", async () => {
    expect(
      await resolve({ ...pilots, TOOL_ROUTER_WORKSPACES: "workspace-2" })
    ).toBeNull();
    expect(stepPilot.ofCaller).not.toHaveBeenCalled();
  });

  it("opens only the router's groups, and names every one the workspace has", async () => {
    const tool = await resolve({ ...pilots, ...phonePilot });
    const parsed = z
      .object({
        description: z.string(),
        inputSchema: z.object({
          "~standard": z.object({
            validate: z.custom<
              (value: { readonly groups: readonly string[] }) => Promise<{
                readonly issues?: readonly object[];
              }>
            >((value) => z.function().safeParse(value).success),
          }),
        }),
      })
      .parse(tool);
    const { routerGroups } = await import("@agent/lib/tool-router/questions");
    for (const group of routerGroups.filter((name) => name !== "files")) {
      expect(parsed.description).toContain(`${group} (`);
    }
    const { validate } = parsed.inputSchema["~standard"];
    expect(
      (await validate({ groups: ["phone", "mail"] })).issues
    ).toBeUndefined();
    expect((await validate({ groups: ["telepathy"] })).issues).toBeDefined();
    expect((await validate({ groups: [] })).issues).toBeDefined();
  });

  it("does not offer a group whose tools the workspace never has", async () => {
    const tool = await resolve(pilots);
    const { description } = z.object({ description: z.string() }).parse(tool);
    // Outside the task agent's and the phone's pilots.
    expect(description).not.toContain("files (");
    expect(description).not.toContain("phone (");
    expect(description).toContain("mail (");
    const withPhone = await resolve({ ...pilots, ...phonePilot });
    expect(
      z.object({ description: z.string() }).parse(withPhone).description
    ).toContain("phone (");
  });
});
