import { defineHook } from "eve/hooks";
import { recordPhoneTurn } from "@agent/lib/phone/policy";
import { isBackgroundTurnText } from "@shared/chat/background-turn";

export default defineHook({
  events: {
    "turn.started"(_event, context) {
      recordPhoneTurn(context.session, "start");
    },
    "message.received"(event, context) {
      recordPhoneTurn(
        context.session,
        event.data.kind === undefined &&
          !isBackgroundTurnText(event.data.message)
          ? "person-message"
          : "background-message"
      );
    },
  },
});
