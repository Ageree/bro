import type { TelegramMessage } from "eve/channels/telegram";
import { z } from "zod";
import { lineName } from "@agent/lib/inbound-media/turn-content";

/**
 * A contact the person sent in Telegram, from the Bot API message eve keeps
 * whole (`message.raw`). Telegram fills `user_id` with the contact's account,
 * so a card whose account is the sender's own is their verified number (the
 * «Поделиться номером» button sends exactly that); a card that is anyone
 * else's, or forwarded, is a number the person talks about.
 */
const contactSchema = z.object({
  contact: z.object({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    phone_number: z.string().min(1),
    user_id: z.number().int().optional(),
  }),
  forward_date: z.number().optional(),
  forward_from: z.unknown().optional(),
  forward_origin: z.unknown().optional(),
  via_bot: z.unknown().optional(),
});

/** The keyboard button that sends the person's own contact card. */
const contactButtonText = "📱 Поделиться номером";
/**
 * The line the button comes with: Telegram posts no keyboard without text.
 * Impersonal: the channel posts it as is, past the person's «ты» or «вы».
 */
export const contactButtonPrompt =
  "Кнопка «📱 Поделиться номером» внизу отправит Бро ваш номер: он запомнит его для форм.";

/** The reply keyboard with the button, hidden after a tap. */
export const contactButtonMarkup = {
  keyboard: [[{ request_contact: true, text: contactButtonText }]],
  one_time_keyboard: true,
  resize_keyboard: true,
};

/**
 * Stands in the text of the refusal that says the errand has no phone to type
 * (`browser_task`): the channel shows the button when it sees it in the
 * failed result, and the model never has to ask for it.
 */
export const phoneButtonMarker = "[phone-button]";

/** Whether a tool result is the refusal that wants the person's number. */
export function asksForPhoneButton(result: {
  readonly kind: string;
  readonly isError?: boolean | undefined;
  readonly output?: unknown;
  readonly toolName?: string | undefined;
}) {
  return (
    result.kind === "tool-result" &&
    result.toolName === "browser_task" &&
    result.isError === true &&
    JSON.stringify(result.output ?? "").includes(phoneButtonMarker)
  );
}

/** What a contact message carries, or undefined when it carries none. */
export function telegramContact(
  message: TelegramMessage,
  senderId: string
):
  | { readonly kind: "own"; readonly phone: string }
  | { readonly kind: "other"; readonly name: string; readonly phone: string }
  | undefined {
  const parsed = contactSchema.safeParse(message.raw);
  if (!parsed.success) return undefined;
  const { contact } = parsed.data;
  const digits = contact.phone_number.replaceAll(/\D/gu, "");
  if (digits.length < 7 || digits.length > 15) return undefined;
  const forwarded =
    parsed.data.forward_origin !== undefined ||
    parsed.data.forward_date !== undefined ||
    parsed.data.forward_from !== undefined ||
    parsed.data.via_bot !== undefined;
  const phone = `+${digits}`;
  if (!forwarded && String(contact.user_id) === senderId) {
    return { kind: "own", phone };
  }
  const name =
    lineName(
      [contact.first_name, contact.last_name].filter(Boolean).join(" ")
    )?.slice(0, 80) ?? "";
  return { kind: "other", name, phone };
}

/** A card this soon after the button was shown is the button's answer. */
const askedForMs = 10 * 60_000;
/** Chats this instance remembers; the oldest go first. */
const rememberedChats = 500;
/** Chats shown the button, by chat id: the turn that showed it and when. */
const shown = new Map<
  string,
  { readonly at: number; readonly turnId: string }
>();

/**
 * Whether the button goes under this refusal: once per turn, because the
 * refusal itself tells the model to call `browser_task` again and a second
 * refusal would post the same keyboard twice.
 */
export function showContactButton(
  chatId: string,
  turnId: string,
  now = Date.now()
) {
  if (shown.get(chatId)?.turnId === turnId) return false;
  shown.delete(chatId);
  shown.set(chatId, { at: now, turnId });
  for (const oldest of shown.keys()) {
    if (shown.size <= rememberedChats) break;
    shown.delete(oldest);
  }
  return true;
}

/** Whether the chat was shown the button in the last 10 minutes. */
export function contactAsked(chatId: string, now = Date.now()) {
  const at = shown.get(chatId)?.at;
  return at !== undefined && now - at <= askedForMs;
}
