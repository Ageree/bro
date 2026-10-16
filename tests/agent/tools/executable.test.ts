import { readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

/** A module of tools resolved per turn or per step. */
const resolverModuleSchema = z.object({
  default: z.object({ events: z.looseObject({}) }),
});

/** A static tool that runs its calls itself. */
const executableModuleSchema = z.object({
  default: z.object({
    execute: z.custom<() => void>(
      (value) => z.function().safeParse(value).success
    ),
  }),
});

/**
 * eve runs a call of an authored tool only through the tool's `execute`. A
 * tool without one is either a question eve turns into a card itself
 * (`ask_question`, by its `request-input` behavior) or a call the AI SDK
 * leaves without a result: eve then ends the turn as if the step had
 * answered (`handleStepResult`, `eve/dist/src/harness/tool-loop.js`), and
 * the call without a result failed every later turn of the session
 * (`AI_MissingToolResultsError`, 16.10). `defineTool` demands an `execute`,
 * so only eve's own tools re-exported here can lack one: `task_cancel` did,
 * because eve gives its dispatch only to a module of its own, never to a
 * re-export (`createRegisteredHarnessToolDefinition`,
 * `eve/dist/src/execution/node-step.js`).
 */
describe("the agent's static tools", () => {
  it("each run their calls, except the question eve answers with a card", async () => {
    // As Bro runs, on a direct provider: `web_search` is then a tool of our
    // own, where the AI Gateway's is searched by the provider itself.
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    const directory = new URL("../../../agent/tools/", import.meta.url);
    const files = readdirSync(directory).filter((file) => file.endsWith(".ts"));

    const withoutExecute = await Promise.all(
      files.map(async (file) => {
        const toolModule: unknown = await import(new URL(file, directory).href);
        return resolverModuleSchema.safeParse(toolModule).success ||
          executableModuleSchema.safeParse(toolModule).success
          ? []
          : [file.replace(/\.ts$/u, "")];
      })
    );

    expect(files.length).toBeGreaterThan(10);
    expect(withoutExecute.flat()).toEqual(["ask_question"]);
    // Every tool module of the agent loads here, which takes a while cold.
  }, 60_000);
});
