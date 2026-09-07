import { defineHook } from "eve/hooks";
import { telegramDeliveryEvents } from "../lib/turn-delivery-events.ts";

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
