import type { TelegramMessage } from "eve/channels/telegram";
import { z } from "zod";
import type { SharedPoint } from "@db/services/location";
import { lineName } from "@agent/lib/inbound-media/turn-content";
import { liveKeyOf } from "@shared/location/geometry";

/**
 * A location the person sent in Telegram, from the Bot API message eve
 * keeps whole (`message.raw`):
 * - their own point (a GPS fix with its accuracy, or the first point of a
 *   live share) is where they are, and may say they left a place;
 * - a venue they picked, not forwarded, is where they probably are: it only
 *   says they arrived (people often pick a place near them from the list);
 * - anything forwarded, and a pin dropped on the map, is a place they talk
 *   about, never where they are.
 */

const locationSchema = z.object({
  horizontal_accuracy: z.number().min(0).max(1_500).optional(),
  latitude: z.number().min(-90).max(90),
  live_period: z.number().int().positive().optional(),
  longitude: z.number().min(-180).max(180),
});

const shareSchema = z.object({
  date: z.number().int().positive(),
  forward_date: z.number().optional(),
  forward_from: z.unknown().optional(),
  forward_origin: z.unknown().optional(),
  location: locationSchema.optional(),
  venue: z
    .object({
      address: z.string().optional(),
      location: locationSchema,
      title: z.string().optional(),
    })
    .optional(),
});

/** The keyboard button that sends the person's location (`location_now` with `ask`). */
const locationButtonText = "📍 Отправить геопозицию";
/** The line the button comes with: Telegram posts no keyboard without text. */
export const locationButtonPrompt =
  "Кнопка «📍 Отправить геопозицию» внизу пришлёт Бро, где ты сейчас.";

/** The reply keyboard with the button: shown once, hidden after a tap. */
export const locationButtonMarkup = {
  keyboard: [[{ request_location: true, text: locationButtonText }]],
  one_time_keyboard: true,
  resize_keyboard: true,
};

/**
 * A `location_now` result that asks the channel for the button: the tool
 * says `locationButton: true` only in a Telegram conversation.
 */
export const locationButtonResultSchema = z.object({
  kind: z.literal("tool-result"),
  output: z.object({ locationButton: z.literal(true) }),
  toolName: z.literal("location_now"),
});

/** A point this soon after the button was shown is the button's answer. */
const askedForMs = 10 * 60_000;
/** Chats this instance remembers asking; the oldest go first. */
const rememberedAsks = 500;

/**
 * Chats shown the button, by chat id: when. A location the button sends
 * may carry no accuracy, the same shape as a pin dropped on the map, so the
 * chat's next plain location is read as the person's own. In this
 * instance's memory, like the bridge throttle: one eve serves the database.
 */
const askedChats = new Map<string, number>();

/** Remembers that the chat was just shown the location button. */
export function rememberLocationAsked(chatId: string, now = Date.now()) {
  askedChats.delete(chatId);
  askedChats.set(chatId, now);
  for (const oldest of askedChats.keys()) {
    if (askedChats.size <= rememberedAsks) break;
    askedChats.delete(oldest);
  }
}

/** Whether the chat was shown the button in the last 10 minutes; forgets it. */
export function takeLocationAsked(chatId: string, now = Date.now()) {
  const at = askedChats.get(chatId);
  askedChats.delete(chatId);
  return at !== undefined && now - at <= askedForMs;
}

/**
 * The location a Telegram message shares, or undefined when it shares none.
 * `asked`, called only for a plain location not forwarded and without its
 * accuracy: whether the chat was just shown the location button, which
 * makes it the person's own (it then says only that they arrived).
 */
export function telegramLocation(
  message: TelegramMessage,
  { asked }: { readonly asked?: () => boolean } = {}
): SharedPoint | undefined {
  const parsed = shareSchema.safeParse(message.raw);
  if (!parsed.success) return undefined;
  const share = parsed.data;
  const location = share.venue?.location ?? share.location;
  if (!location) return undefined;
  const forwarded =
    share.forward_origin !== undefined ||
    share.forward_date !== undefined ||
    share.forward_from !== undefined;
  const base = {
    externalId: `telegram:${message.chat.id}:${message.messageId}:${String(share.date)}`,
    lat: location.latitude,
    live: false,
    lon: location.longitude,
    recordedAt: new Date(share.date * 1000),
  };
  if (share.venue) {
    const title = lineName(share.venue.title)?.slice(0, 80) ?? null;
    const address = lineName(share.venue.address)?.slice(0, 200) ?? null;
    return {
      ...base,
      accuracyM: null,
      address,
      arriveAllowed: !forwarded,
      kind: forwarded ? "place" : "position",
      label: title,
      leaveAllowed: false,
      liveKey: null,
      source: "telegram_venue",
    };
  }
  const measured =
    location.horizontal_accuracy !== undefined ||
    location.live_period !== undefined;
  const own = !forwarded && (measured || (asked?.() ?? false));
  return {
    ...base,
    accuracyM:
      location.horizontal_accuracy === undefined
        ? null
        : Math.round(location.horizontal_accuracy),
    address: null,
    arriveAllowed: own,
    kind: own ? "position" : "place",
    label: null,
    leaveAllowed: own && measured,
    liveKey:
      own && location.live_period !== undefined
        ? liveKeyOf(message.chat.id, message.messageId)
        : null,
    source: "telegram",
  };
}
