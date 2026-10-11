import { defineHook } from "eve/hooks";
import { recordGoTurn } from "@agent/lib/yandex/go/policy";
import { isBackgroundTurnText } from "@shared/chat/background-turn";

export default defineHook({
  events: {
    "turn.started"(_event, context) {
      recordGoTurn(context.session, "start");
    },
    "message.received"(event, context) {
      recordGoTurn(
        context.session,
        event.data.kind === undefined &&
          !isBackgroundTurnText(event.data.message)
          ? "person-message"
          : "background-message",
        event.data.message
      );
    },
  },
});
