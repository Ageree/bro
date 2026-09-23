import { defineDynamic, defineInstructions } from "eve/instructions";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { browserUseConfigured } from "@agent/lib/browser-use/client";
import { getBrowserAutonomyPolicy } from "@db/services/browser-autonomy";
import {
  type BrowserAutonomyPolicy,
  defaultBrowserAutonomyPolicy,
} from "@shared/browser/autonomy";
import availableInstructions from "./content/browser/available.md?raw";
import unavailableInstructions from "./content/browser/unavailable.md?raw";

const capabilityLabels = {
  purchase: "покупки и платные бронирования",
  send: "отправку сообщений и форм",
  "account-change": "изменение настроек аккаунтов",
  delete: "удаление данных",
} as const;

function browserAutonomyInstructions(policy: BrowserAutonomyPolicy) {
  const grants = policy.grants.map((grant) => capabilityLabels[grant]);
  const authority = grants.length
    ? `В кабинете уже дано широкое согласие на ${grants.join(", ")} без повторных подтверждений.`
    : "В кабинете нет сохранённого согласия на покупки, отправку, изменение аккаунтов или удаление без подтверждения.";
  return [
    "## Согласие на действия в браузере",
    authority,
    "Просмотр сайтов и подготовка действий не требуют подтверждения. Для более сильного действия вызывай `browser_task` с честной `capability`: если сохранённого согласия не хватает, нативная карточка инструмента сама запросит одно подтверждение. Не дублируй её вопросом в чате и спрашивай отдельно только недостающие условия или настоящее решение человека.",
    "Согласие действует только внутри цели и ограничений поручения, которое человек действительно дал. Даже сохранённое согласие на покупки или явная просьба об одной покупке не разрешают другую покупку, другой товар или расширение поручения.",
    "Это делегирование на уровне вызова инструмента, а не гарантия контроля каждого клика внешнего сайта.",
  ].join("\n");
}

export default defineDynamic({
  events: {
    async "turn.started"(_event, context) {
      const configured = browserUseConfigured();
      const content = resolveModeValue(context, {
        interactive: configured
          ? availableInstructions
          : unavailableInstructions,
        "scheduled-worker": configured
          ? availableInstructions
          : unavailableInstructions,
      });
      if (content === null) return null;
      if (!configured) return defineInstructions({ content });

      let policy: BrowserAutonomyPolicy = defaultBrowserAutonomyPolicy;
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      if (caller?.principalType === "user") {
        try {
          policy = await getBrowserAutonomyPolicy(scopeFromPrincipal(caller));
        } catch {
          policy = defaultBrowserAutonomyPolicy;
        }
      }

      return defineInstructions({
        content: `${content}\n\n${browserAutonomyInstructions(policy)}`,
      });
    },
  },
});
