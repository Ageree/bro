import { defineDynamic, defineInstructions } from "eve/instructions";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  afishaPurchasePilot,
  yandexPurchasePilot,
} from "@agent/lib/yandex/pilot";
import content from "./content/yandex-purchases.md?raw";

/**
 * Afisha's tickets in its purchase pilot. Without it Bro read «купи билет»
 * as a browser errand (`role/interactive.md`) and never reached
 * afisha.prices, whose result alone named `yandex_purchase` (22.10).
 */
const afishaLine =
  '- Билеты Яндекс Афиши — тоже через API, и когда человек просит купить: `afisha.search` → `afisha.prices` (сеанс, зоны и цены) → зону без мест покупай через `yandex_purchase` с `service: "afisha"` (`prepare`, его `confirmationQuestion`, после «да» — `confirm`). `browser_task` на Афише — только для зоны с местами или когда `yandex` отказал.';

export default defineDynamic({
  events: {
    "turn.started": (_event, context) => {
      const caller = context.session.auth.current;
      if (
        context.channel.kind === "subagent" ||
        !startedByPerson(context) ||
        caller?.principalType !== "user"
      ) {
        return null;
      }
      const scope = scopeFromPrincipal(caller);
      if (!yandexPurchasePilot(scope)) return null;
      return defineInstructions({
        content: afishaPurchasePilot(scope)
          ? `${content.trimEnd()}\n${afishaLine}\n`
          : content,
      });
    },
  },
});
