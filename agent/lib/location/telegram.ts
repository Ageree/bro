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

/** The location a Telegram message shares, or undefined when it shares none. */
export function telegramLocation(
  message: TelegramMessage
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
  const own =
    !forwarded &&
    (location.horizontal_accuracy !== undefined ||
      location.live_period !== undefined);
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
    leaveAllowed: own,
    liveKey:
      own && location.live_period !== undefined
        ? liveKeyOf(message.chat.id, message.messageId)
        : null,
    source: "telegram",
  };
}
