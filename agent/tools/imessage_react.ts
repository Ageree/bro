import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  agentHandle,
  IMESSAGE_TAPBACKS,
  isIMessageTapback,
  reactionTargetId,
  sendIMessageTapback,
} from "../lib/inkbox";
import { attr, turnAttributes } from "../lib/group-guard";

export default defineTool({
  description:
    "iMessage tapback (love/like/dislike/laugh/emphasize/question/eyes) on the latest inbound. Do not pass a message id. Then reply [SILENT]. Use for «ок», «спасибо», «понял», a seen reminder — do not overuse.",
  inputSchema: z.object({
    reaction: z.enum(IMESSAGE_TAPBACKS),
  }),
  async execute({ reaction }, ctx) {
    if (attr(ctx, "channel") === "telegram") {
      return { error: "это Telegram — поставь реакцию через telegram_react" };
    }
    if (!isIMessageTapback(reaction)) return { error: "unsupported reaction" };
    const target = reactionTargetId(turnAttributes(ctx));
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
