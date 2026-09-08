import { defineHook } from "eve/hooks";
import { telegramDeliveryEvents } from "../lib/turn-delivery-events.ts";

/** Sole Telegram delivery path. Channel `events` also fire on new Telegram
 *  sessions, but Eve bundles the hook and channel separately — in-memory
 *  `recordSent` maps are not shared, so a second fire resends every bubble
 *  and dumps the full reply as one concatenated message. iOS then ghosts
 *  cells. Old HTTP-adapter sessions never ran channel events; the hook
 *  covers both. */
export default defineHook({
  events: {
    async "turn.failed"(event, ctx) {
      await telegramDeliveryEvents["turn.failed"](
        {
          turnId: event.data.turnId,
          code: event.data.code,
          message: event.data.message,
        },
        { continuation: { token: ctx.channel.continuationToken } },
        ctx,
      );
    },
    async "message.appended"(event, ctx) {
      await telegramDeliveryEvents["message.appended"](
        {
          turnId: event.data.turnId,
          messageSoFar: event.data.messageSoFar,
        },
        { continuation: { token: ctx.channel.continuationToken } },
        ctx,
      );
    },
    async "actions.requested"(event, ctx) {
      await telegramDeliveryEvents["actions.requested"](
        { turnId: event.data.turnId },
        { continuation: { token: ctx.channel.continuationToken } },
        ctx,
      );
    },
    async "message.completed"(event, ctx) {
      await telegramDeliveryEvents["message.completed"](
        {
          turnId: event.data.turnId,
          finishReason: event.data.finishReason,
          message: event.data.message,
        },
        { continuation: { token: ctx.channel.continuationToken } },
        ctx,
      );
    },
  },
});
