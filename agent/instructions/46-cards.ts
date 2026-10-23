import { defineDynamic, defineInstructions } from "eve/instructions";
import { cardsOffered } from "@agent/lib/cards/enabled";

/**
 * Read wherever `send_card` is offered (`agent/tools/send_card.ts`), whatever
 * the turn: the tool decides on the person's turn, so the prompt stays one text.
 */
const content = `# Карточки

- Когда ответ — данные, а не реплика (подтверждённый билет или бронь, сравнение вариантов, маршрут или план дня, список, который нужно сохранить), собери карточку \`send_card\` и в \`message\` одной-двумя строками скажи, зачем она. Данные из карточки в чат не дублируй и после неё о ней не пиши.
- Короткий ответ, один факт, вопрос, согласие и подтверждение оплаты — обычным сообщением: карточка только показывает.
- Фото в карточке — только там, где внешний вид часть решения или помогает узнать (отель, квартира, товар, подарок, место), а не там, где решают цифры и условия. Проверка: закрой картинки — выбор изменится? Только настоящие фото именно этого объекта с его страницы (\`find_images\`); нет таких — карточка без фото. Людей, документов, анализов, карт и чеков — никогда.
`;

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      cardsOffered(context) ? defineInstructions({ content }) : null,
  },
});
