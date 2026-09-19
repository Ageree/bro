import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import type { z } from "zod";
import { connectGoogleResultSchema } from "@agent/tools/google_connect";
import { agentEvalTags } from "@evals/agent/shared";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";

const urlPattern = /https?:\/\/\S+/u;
const notConfiguredPattern = /не подключ[её]н/iu;
const retryLaterPattern = /не отвеча|попробу/iu;

function deliveryMatches(
  result: z.infer<typeof connectGoogleResultSchema>,
  delivered: string
) {
  if (result.status === "authorize") return delivered.includes(result.url);
  if (result.status === "not_configured") {
    return notConfiguredPattern.test(delivered) && !urlPattern.test(delivered);
  }
  if (result.status === "error") {
    return (
      retryLaterPattern.test(delivered) && !notConfiguredPattern.test(delivered)
    );
  }
  return !urlPattern.test(delivered) && !notConfiguredPattern.test(delivered);
}

export default [
  defineEval({
    description:
      "Offers the Google authorization link when asked to connect Gmail",
    tags: [...agentEvalTags, "routing"],
    async test(t) {
      const turn = await t.send("подключи мой gmail");
      turn.expectOk();
      turn.succeeded();
      const connect = turn.requireToolCall("connect_google", {
        status: "completed",
      });
      turn.calledTool("connect_google", { count: 1 });
      turn.calledTool("send_message");
      const outcome = connectGoogleResultSchema.safeParse(connect.output);
      await t.require(outcome.success, equals(true));
      if (!outcome.success) {
        throw new Error("connect_google returned an unexpected result.");
      }
      const result = outcome.data;

      const deliveries = turn.toolCalls
        .filter(
          (call) => call.name === "send_message" && call.status === "completed"
        )
        .map((call) => sendMessageOutputSchema.safeParse(call.input))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
      const delivered = deliveries
        .map((delivery) =>
          delivery.kind === "link" ? delivery.url : (delivery.text ?? "")
        )
        .join("\n");

      // The delivery must match what the tool actually returned: the minted
      // link itself, not any URL, and "not configured" only when the tool
      // said so rather than as a cover for a transient failure.
      t.check(
        delivered,
        satisfies<string>(
          (value) => deliveryMatches(result, value),
          "delivers the tool's own outcome: its minted URL, or its not-configured or retry message"
        )
      );
    },
  }),
];
