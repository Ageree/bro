import { askQuestion } from "eve/tools/ask_question";

/**
 * eve's `ask_question` with a description of when not to use it. eve's own
 * («use this when you need clarification or a choice») had a model
 * (`openai/gpt-6-luna` on 24.09) confirm what the person had just asked for:
 * «Сохранить их?» after «запомни», «Какие действия выполнить?» after three
 * explicit requests. The approval card of an action is its one confirmation.
 */
const askQuestionDescription =
  "Ask the person one question and wait for the answer. Use it only when the request cannot be carried out without their answer: a detail that has no sensible default, that you cannot find in the conversation, memory, profile or tools, and where a wrong guess would cost money or reach another person. Never use it to confirm what the person already asked for in so many words («запомни», «напомни», «поставь в календарь», «запиши меня», «забронируй»): do it, and an action that needs consent shows its own approval card, which is the only confirmation. Never ask which of several requested things to do: do all of them. Never ask what a date like «завтра» or «в пятницу» means or what a card will show. At most one question per request, together with what you already found.";

/**
 * eve keeps a native tool's pause-for-input behavior under a non-enumerable
 * symbol (`Symbol.for("eve.tool-behavior")`, `eve/dist/src/tools/behavior.js`),
 * which a spread copy would drop, leaving a tool with no `execute` that
 * `eve build` rejects. Copying every own property descriptor keeps it.
 */
export default Object.defineProperties(
  { ...askQuestion },
  {
    ...Object.getOwnPropertyDescriptors(askQuestion),
    description: {
      configurable: true,
      enumerable: true,
      value: askQuestionDescription,
      writable: true,
    },
  }
);
