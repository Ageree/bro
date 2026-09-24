import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { setProactiveMessages } from "@db/services/user-profile";

export const proactiveMessages = defineTool({
  description:
    "Turn Bro's own first messages on or off. When they are on, Bro checks new mail and tomorrow's calendar in the background and writes first only about something that needs the person, such as a flight to check in for or a reply worth drafting. Call with enabled=false when the person asks you to stop writing first, e.g. «не пиши мне сам», «не пиши первым», «хватит напоминаний»; call with enabled=true when they ask you to resume. Replies to their own messages and schedules they set up are not affected.",
  inputSchema: z.object({ enabled: z.boolean() }),
  async execute(input, ctx) {
    const auth = ctx.session.auth.current;
    if (auth?.principalType !== "user") {
      throw new Error("An authenticated user is required.");
    }
    return {
      proactiveMessages: await setProactiveMessages(
        scopeFromPrincipal(auth),
        input.enabled
      ),
    };
  },
});

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeValue(context, {
        interactive: { proactive_messages: proactiveMessages },
      }),
  },
});
