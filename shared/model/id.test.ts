import { describe, expect, it } from "vitest";
import { modelIdSchema } from "@shared/model/id";

describe("model id", () => {
  it.each([
    "openai/gpt-5.6-sol-fast",
    "deepseek/deepseek-v4.1-flash",
    "anthropic/claude-sonnet-4.5",
    "openrouter/auto",
  ])("accepts the gateway and OpenRouter id %s", (modelId) => {
    expect(modelIdSchema.parse(` ${modelId} `)).toBe(modelId);
  });

  it.each(["", "gpt-5.6-sol-fast", "openai/", "/gpt", "openai/gpt 5"])(
    "rejects %s",
    (modelId) => {
      expect(modelIdSchema.safeParse(modelId).success).toBe(false);
    }
  );
});
