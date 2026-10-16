import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  stubDeployment,
  taskAgentDeployment,
} from "@tests/helpers/system-prompt";

/**
 * The task agent's static tools as its model is offered them, outside the
 * files pilot: their names, descriptions and input schemas. The pilot
 * changes what `share_file` accepts only when it runs, never what it says,
 * so this block, and the task agent's prompt cache, stay the same for every
 * other workspace. A deliberate change prints the new digest.
 */

const toolModules = {
  bash: async () => await import("@agent/subagents/task/tools/bash"),
  read_file: async () => await import("@agent/subagents/task/tools/read_file"),
  share_file: async () =>
    await import("@agent/subagents/task/tools/share_file"),
  write_file: async () =>
    await import("@agent/subagents/task/tools/write_file"),
};

const toolSchema = z.object({
  default: z.object({
    description: z.string(),
    inputSchema: z.object({
      "~standard": z.object({
        jsonSchema: z.object({
          input: z.custom<(options: { readonly target: "draft-07" }) => object>(
            (value) => z.function().safeParse(value).success
          ),
        }),
      }),
    }),
  }),
});

const pinnedDigest =
  "ad0344d2a82b47ffb9d181aea9b5bcf1290e1b0b7bff66b97a5d3d89c2d1c4bd";

describe("the task agent's tool block", () => {
  it("stays the same outside the files pilot", async () => {
    stubDeployment({
      ...taskAgentDeployment,
      OPENROUTER_API_KEY: "test-openrouter-key",
    });
    const block = await Promise.all(
      Object.entries(toolModules).map(async ([name, load]) => {
        const tool = toolSchema.parse(await load()).default;
        return {
          description: tool.description,
          inputSchema: tool.inputSchema["~standard"].jsonSchema.input({
            target: "draft-07",
          }),
          name,
        };
      })
    );

    const digest = createHash("sha256")
      .update(JSON.stringify(block))
      .digest("hex");
    expect(digest, `the new digest: ${digest}`).toBe(pinnedDigest);
  });
});
