/**
 * Channel formatting, delivered only to the turns it applies to.
 *
 * WHY this moved out of `instructions.md`. The `## Telegram / iMessage`
 * section was ~740 estimated tokens of the root prompt, and it carried BOTH
 * channels' rules on every single model call — including the halves that
 * contradict each other on purpose. Telegram renders `[label](url)`, real
 * Russian bold, `#` headings, `:::buttons`; iMessage renders none of those and
 * needs a bare URL on its own line. A turn is always exactly one channel, so
 * the other half was never instruction — it was noise, and noise that reads
 * like a rule. `**Русский жирный**` rendering on one channel and not the other
 * is precisely the kind of distinction a small model resolves by picking
 * whichever line it saw last.
 *
 * `routingFromAuth` already decides this for delivery (agent/lib/turn-routing.ts).
 * Reusing it here means the prompt and the transport can never disagree about
 * which channel a turn is on, which a second copy of the decision would
 * eventually allow.
 *
 * A turn with no channel stamped (a background wakeup that has not resolved a
 * transport yet) gets nothing rather than a guess: it has no bubble to format
 * until delivery picks a channel, and `deliverHuman` applies `lastChannel`
 * there without the model's help.
 *
 * prompt-budget: exclusive — the two blocks below are alternatives, never
 * both. The budget report charges this module its larger branch rather than
 * their sum, because no turn ever pays for both.
 */

import { defineDynamic, defineInstructions } from "eve/instructions";
import { routingFromAuth } from "../lib/turn-routing.ts";
import { turnAttributes } from "../lib/turn-attrs";

/** Telegram: markdown in, rich HTML out. Never raw HTML from the model. */
export const TELEGRAM_INSTRUCTION = `Канал этого хода — Telegram.

Пиши markdown, не сырой HTML. Русские **жирный** и *курсив* рендерятся, плюс ++подчёркнутый++, ~~зачёркнутый~~, \`моно\`, ||спойлер||, \`>\` обычная цитата и \`>!\` скрытая.

Объяснение, карточка или список, который будут просматривать глазами, — это rich-карточка: \`#\` заголовки, списки, цитаты, включается строкой \`:::rich\`. Короткие подтверждения остаются простым текстом, и любая карточка всё равно короткая.

Действия — только блоком кнопок, никогда тем же URL в теле сообщения:

\`\`\`
:::buttons
[Открыть](https://example.com)
[Отмена](callback:cancel)
\`\`\`

\`!![описание](url)\` и \`send_photo\` с \`spoiler=true\` прячут фото до нажатия. Входящее \`[button] …\` — это нажатие, \`[voice] …\` — расшифровка. Реакция — \`telegram_react\`, потом \`[SILENT]\`; \`imessage_react\` здесь не существует.`;

/** iMessage: Photon Pro, plain bubbles. Markdown is stripped on the way out. */
export const IMESSAGE_INSTRUCTION = `Канал этого хода — iMessage.

Разметки нет: \`[label](url)\`, \`# заголовки\` и \`\`\`код\`\`\` не рендерятся. Ссылка идёт отдельной строкой. Английский **bold** превращается в Unicode-жирный, русский — нет, поэтому им не пользуйся. Блок \`:::buttons\` станет просто строками-ссылками. Поля \`От:\`, \`Тема:\`, \`Дата:\` подставляются сами.

Зелёный SMS-пузырь — это сбой доставки, а не отправленное сообщение: скажи об этом прямо.

На «ок», «спасибо», «понял» и прочитанное напоминание — \`imessage_react\`, потом \`[SILENT]\`. Вопрос, решение или результат идут текстом. Цель реакции — последнее входящее, id передавать не надо.`;

export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      const channel = routingFromAuth(turnAttributes(ctx)).channel;
      if (!channel) return null;
      return defineInstructions({
        role: "system",
        content: channel === "telegram" ? TELEGRAM_INSTRUCTION : IMESSAGE_INSTRUCTION,
      });
    },
  },
});
