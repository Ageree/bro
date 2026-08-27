import { defineTool } from "eve/tools";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import {
  agentHandle,
  IMESSAGE_TAPBACKS,
  isIMessageTapback,
  reactionTargetId,
  sendIMessageTapback,
} from "../lib/inkbox";

function attrs(ctx: ToolContext): Record<string, unknown> | undefined {
  return (
    ctx.session.auth.current?.attributes ??
    ctx.session.auth.initiator?.attributes
  );
}

function attr(ctx: ToolContext, key: string): string | undefined {
  const raw = attrs(ctx)?.[key];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id === "string" && id.length > 0) return id;
  return undefined;
}

export default defineTool({
  description:
    "Put an iMessage tapback (love/like/dislike/laugh/emphasize/question/eyes) on the latest inbound message of this thread. The target is fixed — do not pass a message id. After calling, reply [SILENT]. Use for «ок», «спасибо», «понял», and a seen reminder — do not overuse.",
  inputSchema: z.object({
    reaction: z.enum(IMESSAGE_TAPBACKS),
  }),
  async execute({ reaction }, ctx) {
    if (!isIMessageTapback(reaction)) return { error: "unsupported reaction" };
    const target = reactionTargetId(attrs(ctx));
    if (!target) return { error: "нет сообщения для реакции" };
    const handle = attr(ctx, "inkboxHandle") ?? agentHandle();
    const sent = await sendIMessageTapback({
      messageId: target,
      reaction,
      handle,
    });
    return {
      id: sent.id,
      reaction: sent.reaction,
      targetMessageId: sent.targetMessageId,
    };
  },
});
