import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { personWordsThisTurn } from "@agent/lib/browser-use/said";
import { savedFormOfAddressNote } from "@agent/lib/delivery/language";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { formOfAddressSchema } from "@shared/chat/form-of-address";
import { updateFormOfAddress } from "@db/services/settings";

/** «на вы», «на «ты»», «по имени»: how someone is to be addressed. */
const addressForm =
  /(?<!\p{L})(?:на\s*[«"„“]?\s*(?:вы|ты)(?!\p{L})|по\s+(?:имени|отчеству)(?!\p{L}))/u;

/**
 * The person asking Bro itself to switch: «давай на вы», «можно на ты»,
 * «давайте перейдём на ты», «давай уже общаться на вы». Only these words
 * may stand between, so «давай ответь ей на вы» is about the letter.
 */
const switchRequest =
  /(?<!\p{L})(?:давай(?:те)?|можно|перейд\p{L}*|переход\p{L}*|перейти|будем|общ\p{L}*)(?:-ка)?(?:\s+(?:ли|бы|уже|лучше|тогда|теперь|сразу|снова|опять|ещё|еще|всё|все|мы|пожалуйста|с\s+тобой|с\s+вами|перейд\p{L}*|будем|общаться|говорить|обращаться|друг\s+к\s+другу))*\s+на\s*[«"„“]?\s*(?:вы|ты)(?!\p{L})/u;

/**
 * A verb of addressing or naming with no one else as its object: «зови
 * меня Саша», «обращайся на вы» — but not «обращайся к ней на вы» or
 * «называй Ирину по имени». Matched on the original case, so a capitalised
 * name right after the verb reads as someone else.
 */
const namingVerb =
  /(?<!\p{L})(?:[Зз]ови(?:те)?|[Нн]азывай(?:те)?|[Оо]бращайся|[Оо]бращайтесь|[Оо]бращаться|[Зз]вать|[Нн]азывать)(?!\p{L})(?!\s+(?:к\s+|ко\s+)?(?:ней|нему|ним|неё|него|них|ей|ему|им|её|его|их|\p{Lu})(?!\p{L}))/u;

/** «ко мне», «со мной», «мне», «меня»: the person speaking of themselves. */
const firstPerson = /(?<!\p{L})(?:мне|меня|мной)(?!\p{L})/u;

/** «меня зовут Саша», "call me Alex", "be formal with me". */
const selfNaming =
  /(?<!\p{L})меня\s+зовут(?!\p{L})|\b(?:call\s+me|address\s+me|with\s+me|to\s+me|my\s+name\s+is)\b/iu;

/**
 * Asking Bro to write or pass on something to someone: «ответь Ирине»,
 * «напиши Лёше», «письмо», "reply to Sam".
 */
const writingRequest =
  /(?<!\p{L})(?:ответь(?:те)?|ответить|напиши(?:те)?|написать|отправь(?:те)?|отправить|составь(?:те)?|составить|перешли(?:те)?|переслать|передай(?:те)?|передать|скинь(?:те)?|черновик\p{L}*|письм\p{L}*|сообщени\p{L}*|reply|respond|write|draft|e-?mail\p{L}*|message)(?!\p{L})/u;

/** «с ней на вы», «ему на ты»: someone else, next to a form of address. */
const thirdPerson =
  /(?<!\p{L})(?:ей|ему|им|ней|нему|ним|неё|него|них|her|him|them)(?!\p{L})/u;

/**
 * Whether the person's words this turn are about how to write to someone
 * else rather than how Bro should address them: on 25.09 (RU d09) «ответь
 * Ирине Павловне … на вы, как обычно» switched Bro to «вы» with the person
 * in every chat. Any sign that the person means Bro itself — «давай на вы»,
 * «обращайся ко мне», «зови меня», «мне на ты» — keeps the call going, and
 * so does any answer to Bro's own question that names a form or a name
 * («на вы» to «как к вам обращаться?»): a wrong refusal would cost more than
 * a missed one.
 */
export function aboutSomeoneElse(
  said: readonly string[],
  answers: readonly string[] = []
) {
  const text = said.join("\n");
  const lower = text.toLowerCase();
  const clauses = lower.split(/[.!?;:,\n—–]+/u);
  const meansBro =
    switchRequest.test(lower) ||
    namingVerb.test(text) ||
    selfNaming.test(text) ||
    clauses.some(
      (clause) => addressForm.test(clause) && firstPerson.test(clause)
    ) ||
    answers.some(
      (answer) =>
        addressForm.test(answer.toLowerCase()) ||
        namingVerb.test(answer) ||
        selfNaming.test(answer)
    );
  if (meansBro) return false;
  return (
    writingRequest.test(lower) ||
    clauses.some(
      (clause) => addressForm.test(clause) && thirdPerson.test(clause)
    )
  );
}

/** What the model reads when the words were about someone else's letter. */
const aboutSomeoneElseNote =
  "Not saved. The person's message this turn is about writing to someone else, so «вы», «ты» or a name there is how to write that letter or message, not how you address the person. Write the letter that way and keep addressing the person exactly as before. This tool is only for when the person asks you yourself to switch («давай на вы», «обращайся ко мне на ты», «зови меня Саша»).";

/**
 * `aboutLetter` is set when the person's words this turn are about writing
 * to someone else (`aboutSomeoneElse`): the call is then not saved.
 */
function defineFormOfAddress(aboutLetter: boolean) {
  return defineTool({
    description:
      "Save how the person wants YOU to address THEM, for every chat and channel from now on. Call with formal=true when they ask you to switch to «вы» with them («давай на вы», «обращайся ко мне на вы»), formal=false when they ask for «ты» («можно на ты», «давай на ты»). Call with name when they ask to be called by a particular name («зови меня Саша»), name=null when they ask to drop it. Never call it for how a letter or message to someone else should be written: «ответь Ирине на вы» or «напиши Лёше на ты» is about that letter, and Bro keeps addressing the person as before. Use this, not profile__save_memory, for «ты»/«вы» and the name to call them; their legal name for forms goes to personal_info. Switch to the new form in the reply right away.",
    inputSchema: z
      .object({
        formal: formOfAddressSchema.shape.formal.optional(),
        name: formOfAddressSchema.shape.name.optional(),
      })
      .refine(
        (input) => input.formal !== undefined || input.name !== undefined,
        "Pass formal, name, or both."
      ),
    async execute(input, ctx) {
      if (aboutLetter) {
        return { note: aboutSomeoneElseNote, saved: false };
      }
      const auth = ctx.session.auth.current;
      if (auth?.principalType !== "user") {
        throw new Error("An authenticated user is required.");
      }
      const saved = await updateFormOfAddress(scopeFromPrincipal(auth), input);
      return { formOfAddress: saved, note: savedFormOfAddressNote(saved) };
    },
  });
}

export const formOfAddress = defineFormOfAddress(false);

export default defineDynamic({
  events: {
    // Resolved before every step, so an answer the person gave to Bro's own
    // question in this turn counts as their words too.
    "step.started": (_event, context) => {
      const { answers, said } = personWordsThisTurn(context.messages);
      const aboutLetter = said !== null && aboutSomeoneElse(said, answers);
      return resolveModeValue(context, {
        interactive: { form_of_address: defineFormOfAddress(aboutLetter) },
      });
    },
  },
});
