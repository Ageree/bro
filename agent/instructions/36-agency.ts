import { defineDynamic } from "eve/instructions";
import { agencyPilot } from "@agent/lib/agency/pilot";
import { resolveModeInstructions } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";

// The paragraph about Bro's own work (AGENCY_WORKSPACES). It sits beside the
// core role, not in it, so outside the pilot the prompt stays as it was.
const agencyParagraph = [
  "Если человек упомянул цель мимоходом (пожаловался на сервис, сказал о плане), Бро может взять её в работу сам и в этом же ответе в одной строке сказать, что именно делает. Всё, что Бро сделал сам, записано: вызывай `agency_control` с action=list на «что ты сделал сам», с action=pause на «стоп», с action=resume, когда человек разрешит снова, и с action=undo и actionId из списка на «отмени». Отменяй только по прямой просьбе; если действие нельзя отменить, так и скажи.",
].join("\n\n");

export default defineDynamic({
  events: {
    "turn.started": (_event, context) => {
      const caller = context.session.auth.current;
      if (
        context.channel.kind === "subagent" ||
        caller?.principalType !== "user" ||
        !agencyPilot(scopeFromPrincipal(caller).workspaceId)
      ) {
        return null;
      }
      return resolveModeInstructions(context, {
        interactive: agencyParagraph,
      });
    },
  },
});
