import { defineEval, type EveEvalContext } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { z } from "zod";
import {
  agentEvalTags,
  assertPlainTextDelivery,
  requireDeliveredTexts,
} from "@evals/agent/shared";

const formalInputSchema = z.object({ formal: z.boolean() });

/**
 * Feminine first-person forms Bro used about itself («сделаю сама», «я
 * готова»). `\b` is ASCII-only in JavaScript, so letters bound the words.
 */
const feminineSelf =
  /(?<!\p{L})(?:сама|готова|рада|уверена|сделала|нашла|поняла|справилась|составила|посмотрела|проверила|подготовила|набросала)(?!\p{L})/iu;

/** «ты» in any case and «твой» in any form. */
const informalPronoun =
  /(?<!\p{L})(?:ты|тебе|тебя|тобой|твой|твоя|твоё|твое|твои|твоего|твоей|твоих|твоим|твоими|твою)(?!\p{L})/iu;

function checkMasculine(t: EveEvalContext, text: string) {
  t.check(
    text,
    satisfies<string>(
      (value) => !feminineSelf.test(value),
      "Bro never speaks of itself in the feminine"
    )
  );
}

/**
 * A quoted title is not Bro's own words: «Кто угодно, кроме тебя» is a film
 * a formal reply may still recommend.
 */
function ownWords(text: string) {
  return text.replaceAll(/«[^»]*»|"[^"]*"|“[^”]*”/gu, " ");
}

function checkFormal(t: EveEvalContext, text: string, label: string) {
  t.check(
    text,
    satisfies<string>(
      (value) => !informalPronoun.test(ownWords(value)),
      `${label}: no «ты» or «твой» after the person asked for «вы»`
    )
  );
  t.judge(
    "The reply is in Russian and addresses the person formally with «вы» throughout (вы, вам, ваш, plural imperatives such as «посмотрите»), never with «ты», «тебе», «твой» or singular informal imperatives. Bro speaks of itself in the masculine gender if at all.",
    { on: text }
  )
    .label(label)
    .atLeast(0.8);
}

export default [
  defineEval({
    description: "Speaks of itself in the masculine in Russian",
    tags: [...agentEvalTags, "conversation", "language", "smoke"],
    async test(t) {
      const turn = await t.send(
        "сделаешь? нужен короткий план на субботу: утром спортзал, днём встреча с другом, вечером кино. и скажи честно, справишься или мне заняться этим?"
      );
      turn.expectOk();
      turn.succeeded();
      turn.notCalledTool("form_of_address");
      const text = await requireDeliveredTexts(t, turn);
      assertPlainTextDelivery(t, text);
      checkMasculine(t, text);
      t.judge(
        "The reply is in Russian, gives a short Saturday plan, and whenever Bro refers to itself it uses masculine forms (e.g. «сделал», «готов», «справлюсь сам»), never feminine ones (e.g. «сделала», «готова», «сама»). It addresses the person with «ты».",
        { on: text }
      )
        .label("masculine voice")
        .atLeast(0.8);
    },
  }),
  defineEval({
    description: "Keeps «вы» once asked, in the same chat and a new one",
    tags: [...agentEvalTags, "conversation", "language"],
    async test(t) {
      let evaluationError: Error | undefined;
      try {
        const asked = await t.send(
          "давай на вы, пожалуйста. и подскажи, что почитать в отпуске на море?"
        );
        asked.expectOk();
        asked.succeeded();
        asked.calledTool("form_of_address", {
          count: 1,
          input: (input) =>
            formalInputSchema.safeParse(input).data?.formal === true,
          status: "completed",
        });
        checkFormal(
          t,
          await requireDeliveredTexts(t, asked),
          "formal right after asking"
        );

        // `t.send` opens a new chat each time; the follow-up belongs to this
        // one, or the model rightly says it cannot see what came before.
        const next = await asked.session.send(
          "а что-нибудь полегче, детектив?"
        );
        next.expectOk();
        next.succeeded();
        checkFormal(
          t,
          await requireDeliveredTexts(t, next),
          "formal later in the same chat"
        );

        const laterSession = await t.session();
        const later = await laterSession.send(
          "какой фильм посмотреть сегодня вечером? что-нибудь лёгкое"
        );
        later.expectOk();
        later.succeeded();
        later.notCalledTool("form_of_address");
        const laterText = await requireDeliveredTexts(t, later);
        assertPlainTextDelivery(t, laterText);
        checkFormal(t, laterText, "formal in a new chat");
      } catch (error) {
        evaluationError =
          error instanceof Error
            ? error
            : new Error("Form of address evaluation failed.", {
                cause: error,
              });
      }

      // The setting is per workspace, so the next case must find «ты» again.
      let cleanupError: Error | undefined;
      try {
        const cleanupSession = await t.session();
        const cleanup = await cleanupSession.send(
          "давай снова на ты, так привычнее"
        );
        cleanup.expectOk();
        cleanup.succeeded();
        cleanup.calledTool("form_of_address", {
          count: 1,
          input: (input) =>
            formalInputSchema.safeParse(input).data?.formal === false,
          status: "completed",
        });
      } catch (error) {
        cleanupError =
          error instanceof Error
            ? error
            : new Error("Form of address cleanup failed.", { cause: error });
      }

      if (evaluationError && cleanupError) {
        throw new AggregateError(
          [evaluationError, cleanupError],
          "Form of address evaluation and cleanup both failed."
        );
      }
      if (evaluationError) throw evaluationError;
      if (cleanupError) throw cleanupError;
    },
  }),
];
