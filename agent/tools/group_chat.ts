import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  groupHowtoText,
  parseGroupCreatePhones,
} from "../../convex/lib/groupChatPolicy.ts";
import { bindGroupInbound, getTenant } from "../lib/convex";
import { isGroupTurn } from "../lib/group-guard";
import { agentHandle, sendBlueIMessageGroup } from "../lib/inkbox";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Add Bro to an iMessage group. howto explains saving the contact and adding the number. create opens a new group from Bro's dedicated line with 2–8 E.164 numbers and a first message. Personal errands stay in the 1:1 thread. Do not use create from inside an existing group.",
  inputSchema: z.object({
    action: z.enum(["howto", "create"]).default("howto"),
    phones: z.array(z.string().min(8).max(20)).max(8).optional(),
    text: z.string().min(1).max(500).optional(),
  }),
  async execute({ action, phones, text }, ctx) {
    if (action === "howto") return groupHowtoText();
    if (isGroupTurn(ctx)) {
      return "Уже в группе. Новый чат открывай из лички.";
    }
    const phone = tenantId(ctx);
    const tenant = await getTenant(phone);
    const handle = tenant?.inkboxHandle ?? agentHandle();
    const line = tenant?.dedicatedIMessageNumber;
    if (!line) {
      return `${groupHowtoText()}\n\nСоздать чат сам не могу: нет номера Bro. Сохрани карточку контакта, когда номер появится.`;
    }
    const parsed = parseGroupCreatePhones(phones ?? [], [line, phone]);
    if (!parsed.ok) return parsed.reason;
    const body = text?.trim() || "Я Bro. Пишите «бро …», когда нужна помощь.";
    const sent = await sendBlueIMessageGroup({
      to: parsed.to,
      text: body,
      handle,
    });
    const rawId =
      sent.conversationId ??
      (sent as { conversation_id?: string }).conversation_id;
    const conversationId = typeof rawId === "string" ? rawId : "";
    if (!conversationId) {
      return "group created but conversation id missing";
    }
    await bindGroupInbound({
      conversationId,
      senderPhone: phone,
      participants: parsed.to,
      handle: tenant?.inkboxHandle,
      ownerPhone: phone,
    });
    return `opened group ${conversationId} with ${parsed.to.join(", ")}`;
  },
});
