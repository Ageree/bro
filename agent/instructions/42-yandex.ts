import { defineDynamic, defineInstructions } from "eve/instructions";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { yandexPurchasePilot } from "@agent/lib/yandex/pilot";
import content from "./content/yandex-purchases.md?raw";

export default defineDynamic({
  events: {
    "turn.started": (_event, context) => {
      const caller = context.session.auth.current;
      if (
        context.channel.kind === "subagent" ||
        !startedByPerson(context) ||
        caller?.principalType !== "user" ||
        !yandexPurchasePilot(scopeFromPrincipal(caller))
      ) {
        return null;
      }
      return defineInstructions({ content });
    },
  },
});
