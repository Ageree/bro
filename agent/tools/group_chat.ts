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
    const lineStatus = tenant?.dedicatedIMessageNumberStatus;
    if (!line) {
      return `${groupHowtoText()}\n\nСоздать чат сам не могу: нет номера Bro. Сохрани карточку контакта, когда номер появится.`;
    }
    if (lineStatus && lineStatus !== "active") {
      return `Номер Bro ещё не готов (${lineStatus}). Попробуй позже.`;
    }
    // Inkbox `to` is the other members; Bro's line is implicit. Keep the
    // asking owner in the roster so "открой чат с Машей" includes them.
    const parsed = parseGroupCreatePhones([phone, ...(phones ?? [])], [line]);
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
    const bound = await bindGroupInbound({
      conversationId,
      senderPhone: phone,
      participants: parsed.to,
      handle,
      ownerPhone: phone,
    });
    if (!bound.ok) {
      return `opened group ${conversationId}, but bind failed: ${bound.reason}`;
    }
    return `opened group ${conversationId} with ${parsed.to.join(", ")}`;
  },
});
