import { askQuestion } from "eve/tools/ask_question";
import { z } from "zod";

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
 * eve's input with a prompt that says something. On 25.09 (RU d13)
 * gpt-6-luna saved a memory and then called `ask_question` with
 * `{"prompt":"","options":[]}`: the person got an empty question card, and
 * the turn waited for their answer to it. `eve build` keeps a static tool's
 * input schema as JSON Schema and validates each call against it again at
 * run time (`eve/dist/src/tools/schema.js`); a call that fails reaches the
 * model as a tool error, and eve puts up no card for it
 * (`eve/dist/src/harness/input-extraction.js`). So the rule has to be one
 * JSON Schema can carry — a pattern, not a refinement. eve's schema comes
 * from its own copy of zod, which `instanceof` still recognizes.
 */
const eveInputSchema = askQuestion.inputSchema;
if (!(eveInputSchema instanceof z.ZodObject)) {
  throw new TypeError("eve's ask_question input is no longer a zod object.");
}
const inputSchema = eveInputSchema.extend({
  prompt: z
    .string()
    .regex(/\S/u)
    .describe(
      "The question itself, in the person's language, as they will read it. Never empty."
    ),
});

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
    inputSchema: {
      configurable: true,
      enumerable: true,
      value: inputSchema,
      writable: true,
    },
  }
);
