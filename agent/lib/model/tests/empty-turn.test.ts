import { generateText, streamText, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { emptyDeliveryMarker } from "@agent/lib/delivery/empty";
import { emptyTurnSelection } from "@agent/lib/model/empty-turn";

const tools = {
  send_message: tool({ inputSchema: z.object({ text: z.string() }) }),
};

describe("the model of a turn that calls none", () => {
  it("ends a streamed step in the empty-delivery marker, free", async () => {
    const result = streamText({
      model: emptyTurnSelection.model,
      prompt: "Поручение закончено.",
      tools,
    });

    expect(await result.text).toBe(emptyDeliveryMarker);
    expect(await result.toolCalls).toEqual([]);
    expect(await result.finishReason).toBe("stop");
    expect((await result.finalStep).providerMetadata?.gateway?.cost).toBe(0);
    // eve keeps a known input size as the history's: none is given.
    expect((await result.finalStep).usage.inputTokens).toBeUndefined();
  });

  it("answers a step asked without streaming the same way", async () => {
    const result = await generateText({
      model: emptyTurnSelection.model,
      prompt: "Поручение закончено.",
      tools,
    });

    expect(result.text).toBe(emptyDeliveryMarker);
    expect(result.toolCalls).toEqual([]);
  });
});
