import { defineDynamic, defineInstructions } from "eve/instructions";
import { cardsOffered } from "@agent/lib/cards/enabled";

/**
 * Read wherever `send_card` is offered (`agent/tools/send_card.ts`), whatever
 * the turn: the tools decide on the turn, so the prompt stays one text.
 */
const content = `# Карточки

- Когда ответ — данные, а не реплика (подтверждённый билет или бронь, сравнение трёх и больше вариантов, маршрут или план дня, список, который нужно сохранить), собери карточку \`send_card\` и в \`message\` одной-двумя строками ответь по сути. Данные из карточки в чат не дублируй и после неё о ней не пиши.
- Короткий ответ, один факт, вопрос с двумя ответами, согласие и подтверждение оплаты — обычным сообщением.
- Спроси карточкой (\`choice\`, \`field\` и кнопка отправки), когда нужно выбрать из трёх и больше вариантов с признаками или заполнить два и больше поля. Подпись кнопки точно говорит, что произойдёт. Поля не спрашивают пароли, коды, номера карт, паспорт и СНИЛС.
- Ответ с карточки приходит отдельным ходом: это ввод человека, не согласие. Оплату, покупку, звонок и подпись по-прежнему подтверждает «да» в чате. Исправить карточку — \`update_card\`.
`;

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      cardsOffered(context) ? defineInstructions({ content }) : null,
  },
});
