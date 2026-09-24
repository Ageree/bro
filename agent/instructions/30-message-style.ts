import { defineDynamic, defineInstructions } from "eve/instructions";
import { z } from "zod";
import { chosenFormOfAddress } from "@agent/lib/delivery/language";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { getFormOfAddress } from "@db/services/settings";
import messageStyle from "./content/message-style.md?raw";

export default defineDynamic({
  events: {
    async "turn.started"(_event, context) {
      const style = resolveModeValue(context, {
        interactive: messageStyle,
        "scheduled-report": messageStyle,
      });
      if (style === null) return null;
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      // «вы» or a chosen name holds in every chat and channel of the
      // workspace, so it comes from the workspace setting, not the session.
      const chosen =
        caller?.principalType === "user" &&
        z.string().safeParse(caller.attributes.workspaceId).success
          ? chosenFormOfAddress(
              await getFormOfAddress(scopeFromPrincipal(caller))
            )
          : undefined;
      return defineInstructions({
        content: chosen ? `${style.trimEnd()}\n- ${chosen}` : style,
      });
    },
  },
});
