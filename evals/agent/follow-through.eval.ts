import { defineEval, type EveEvalToolCall, type EveEvalTurn } from "eve/evals";
import { z } from "zod";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  agentEvalTags,
  cancelStartedRuns,
  checkNoQuestionBeforeCard,
  requireDeliveredTexts,
  skipWithoutBrowser,
} from "@evals/agent/shared";

/**
 * RU 24.09: «зарегистрируй меня, как откроется» ended with no check-in set
 * up (d02), the readings were never passed (d08), and a chain stopped after
 * its first step (d18) — each time with «напиши, если нужно». A step of the
 * person's own goal that opens later is set up at once; a schedule nobody
 * asked for is not (d02 again). A browser case runs on a real site only up
 * to its first report and is cancelled in `finally`.
 */
const tags = [...agentEvalTags, "autonomy", "follow-through"] as const;

const evalScope = accessScopeForUser("better-auth:browser-benchmark");

const hourMs = 60 * 60_000;

/** A departure five days from now at 09:30 in Moscow, as ISO and as said. */
function departureInFiveDays() {
  const moscowDate = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
    year: "numeric",
  }).format(new Date(Date.now() + 5 * 24 * hourMs));
  const [year, month, day] = moscowDate.split("-");
  return {
    at: new Date(`${moscowDate}T09:30:00+03:00`),
    said: `${day ?? ""}.${month ?? ""}.${year ?? ""} в 09:30`,
  };
}

const onceTimingSchema = z.object({
  timing: z.object({
    at: z.iso.datetime({ offset: true }),
    kind: z.literal("once"),
  }),
});

const startSchema = z.object({
  action: z.literal("start"),
  allowSubmit: z.boolean().optional(),
  deliveryAddress: z.boolean().optional(),
  site: z.string().optional(),
  task: z.string(),
});

const deliveryWords =
  /доставк|привез|курьер|лавк|самокат|купер|вкусвилл|пункт\s+выдачи/iu;

export default [
  defineEval({
    description:
      "Sets up online check-in for a flight the person has, for when it opens, and says so",
    tags,
    async test(t) {
      const departure = departureInFiveDays();
      let turn: EveEvalTurn | undefined;
      try {
        turn = await t.send(
          `Билет уже куплен: Аэрофлот SU 1124, Москва (Шереметьево) — Сочи, вылет ${departure.said} по Москве. Зарегистрируй меня, как откроется онлайн-регистрация.`
        );
        turn.expectOk();
        turn.notCalledTool("ask_question");
        // The check-in itself can only happen once it opens: the step is set
        // up now, for a moment before the departure, not left to the person.
        turn.calledTool("schedules-create", {
          input: (input: EveEvalToolCall["input"]) => {
            const at = onceTimingSchema.safeParse(input).data?.timing.at;
            if (at === undefined) return false;
            const lead = departure.at.getTime() - new Date(at).getTime();
            return lead >= hourMs && lead <= 48 * hourMs;
          },
          status: "completed",
        });
        const text = await requireDeliveredTexts(t, turn);
        t.judge(
          "The reply tells the person that online check-in for flight SU 1124 is set up for when it opens and names when that is (a day or a time before the departure). It does not end with an offer like «напиши, если нужно» instead of doing it.",
          { on: text }
        )
          .label("check-in set up and named")
          .atLeast(0.7);
      } finally {
        await cancelStartedRuns(turn);
      }
    },
  }),
  defineEval({
    description:
      "Names when check-in opens but schedules nothing when only asked about it",
    tags,
    async test(t) {
      const turn = await t.send(
        "Во сколько открывается онлайн-регистрация у Аэрофлота?"
      );
      turn.expectOk();
      // A question about a rule is not an errand: nothing to set up for it.
      turn.notCalledTool("schedules-create");
      await requireDeliveredTexts(t, turn);
    },
  }),
  defineEval({
    description:
      "Gives the first grocery run the saved delivery address, without a question",
    tags: [...tags, "browser"],
    async test(t) {
      await skipWithoutBrowser(t);
      const { patchUserProfile, readUserProfile } =
        await import("@db/services/user-profile");
      const before = await readUserProfile(evalScope);
      await patchUserProfile(evalScope, {
        addressLine1: "ул. Тверская, 7, кв. 12",
        city: "Москва",
        countryCode: "RU",
        postalCode: "125009",
      });

      let turn: EveEvalTurn | undefined;
      try {
        turn = await t.send(
          "закажи продукты к восьми вечера: молоко 3,2, десяток яиц, 2 авокадо, куриное филе около кило и чего-нибудь к чаю. если чего-то нет, замени похожим, но скажи что заменил"
        );
        turn.expectOk();
        checkNoQuestionBeforeCard(t, turn);
        // RU 24.09, d05: the first run had no address and a second one was
        // needed. The first start is about delivery, so the run gets the
        // saved address for the site's address picker from the start.
        turn.calledTool("browser_task", {
          input: (input: EveEvalToolCall["input"]) => {
            const start = startSchema.safeParse(input);
            return (
              start.success &&
              (start.data.deliveryAddress === true ||
                deliveryWords.test(start.data.task))
            );
          },
        });
      } finally {
        await cancelStartedRuns(turn);
        await patchUserProfile(evalScope, {
          addressLine1: before.addressLine1,
          city: before.city,
          countryCode: before.countryCode,
          postalCode: before.postalCode,
        });
      }
    },
  }),
  defineEval({
    description:
      "Looks for the usual item in the site's order history instead of asking which one",
    tags: [...tags, "browser"],
    async test(t) {
      await skipWithoutBrowser(t);

      let turn: EveEvalTurn | undefined;
      try {
        turn = await t.send(
          "закажи на озоне тот же корм коту, что в прошлый раз, две пачки, в мой пункт выдачи"
        );
        turn.expectOk();
        // RU 24.09, d04: the item is in the account's own order history,
        // which the run reads; asking «какой корм?» is not the answer.
        checkNoQuestionBeforeCard(t, turn);
        turn.calledTool("browser_task", {
          input: (input: EveEvalToolCall["input"]) => {
            const start = startSchema.safeParse(input);
            return (
              start.success &&
              start.data.allowSubmit !== true &&
              /ozon/iu.test(start.data.site ?? start.data.task)
            );
          },
        });
      } finally {
        await cancelStartedRuns(turn);
      }
    },
  }),
];
