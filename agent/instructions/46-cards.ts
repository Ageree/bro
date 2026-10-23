import { defineDynamic, defineInstructions } from "eve/instructions";
import { cardsOffered } from "@agent/lib/cards/enabled";

/**
 * Read wherever `send_card` is offered (`agent/tools/send_card.ts`), whatever
 * the turn: the tool decides on the person's turn, so the prompt stays one text.
 */
const content = `# Карточки

- Когда ответ — данные, а не реплика (подтверждённый билет или бронь, сравнение вариантов, маршрут или план дня, список, который нужно сохранить), собери карточку \`send_card\` и в \`message\` одной-двумя строками скажи, зачем она. Данные из карточки в чат не дублируй и после неё о ней не пиши.
- Короткий ответ, один факт, вопрос, согласие и подтверждение оплаты — обычным сообщением: карточка только показывает.
`;

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      cardsOffered(context) ? defineInstructions({ content }) : null,
  },
});
