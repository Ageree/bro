import { readFileSync } from "node:fs";
import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";

/**
 * Events a real Bro turn streamed through `eve/client` (eve 0.62, OpenRouter
 * model), journaled by the driver; text deltas are dropped and the inline
 * photo shortened to keep the fixtures small.
 *
 * - `uc-mo-split`: one question, one `send_message` answer.
 * - `uc-ma-event-from-photo`: a photo, two calendar approval cards the driver
 *   approved, the tool failing both times, and Bro saying so.
 */

// eve/client exports the event types but no schema; the envelope check keeps
// a damaged fixture from reaching the assertions as a typed event.
const envelopeSchema = z.object({
  data: z.looseObject({}).optional(),
  meta: z.object({ at: z.string(), id: z.string() }),
  type: z.string(),
});
const recordedEventSchema = z.custom<MessageStreamEvent>(
  (value) => envelopeSchema.safeParse(value).success
);

export function recordedEvents(name: "uc-ma-event-from-photo" | "uc-mo-split") {
  const text = readFileSync(
    new URL(`fixtures/${name}.events.jsonl`, import.meta.url),
    "utf8"
  );
  return text
    .trim()
    .split("\n")
    .map((line) => recordedEventSchema.parse(JSON.parse(line)));
}
