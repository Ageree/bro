import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { agentEvalTags } from "@evals/agent/shared";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";

const urlPattern = /https?:\/\/\S+/u;
const notConfiguredPattern = /не подключ[её]н/iu;

export default [
  defineEval({
    description:
      "Offers the Google authorization link when asked to connect Gmail",
    tags: [...agentEvalTags, "routing"],
    async test(t) {
      const turn = await t.send("подключи мой gmail");
      turn.expectOk();
      turn.succeeded();
      turn.calledTool("connect_google", { count: 1 });
      turn.calledTool("send_message");

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

      t.check(
        delivered,
        satisfies<string>(
          (value) => urlPattern.test(value) || notConfiguredPattern.test(value),
          "delivers the authorization URL or says Google is not configured"
        )
      );
    },
  }),
];
