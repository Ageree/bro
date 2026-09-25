import { defineEval, type EveEvalToolCall, type EveEvalTurn } from "eve/evals";
import { z } from "zod";
import {
  agentEvalTags,
  cancelStartedRuns,
  checkNoQuestionBeforeCard,
  requireDeliveredTexts,
  skipWithoutBrowser,
} from "@evals/agent/shared";

/**
 * RU 24.09: Госуслуги came back as «штрафов нет, но висит 500 ₽ к оплате»
 * (d06), meter readings were never staged (d08), and «найди билеты… место у
 * прохода, и зарегистрируй меня» ended on a list of flights (d02). A browser
 * case runs on a real site only up to its first report and is cancelled in
 * `finally`.
 */
const tags = [...agentEvalTags, "public-services"] as const;

const startSchema = z.object({
  action: z.literal("start"),
  allowSubmit: z.boolean().optional(),
  site: z.string().optional(),
  task: z.string(),
});

function searchStart(
  input: EveEvalToolCall["input"],
  matches: (start: z.infer<typeof startSchema>) => boolean
) {
  const start = startSchema.safeParse(input);
  return (
    start.success && start.data.allowSubmit !== true && matches(start.data)
  );
}

export default [
  defineEval({
    description:
      "Asks before passing a meter reading lower than the one before, instead of passing it",
    tags,
    async test(t) {
      const turn = await t.send(
        "Показания воды: холодная 123, горячая 45. В прошлом месяце холодная была 130, горячая 41. Передай."
      );
      turn.expectOk();
      // A reading below the last one is a misread digit or a swapped meter:
      // it is asked about once, before anything is staged.
      turn.notCalledTool("browser_task");
      const text = await requireDeliveredTexts(t, turn);
      t.judge(
        "The reply points out that the cold-water reading (123) is lower than last month's (130) and asks the person to check it before passing the readings. It does not say the readings were passed.",
        { on: text }
      )
        .label("asks about the reading below last month")
        .atLeast(0.7);
    },
  }),
  defineEval({
    description:
      "Checks fines, taxes and the passport's expiry on Госуслуги in one errand",
    tags: [...tags, "browser"],
    async test(t) {
      await skipWithoutBrowser(t);
      let turn: EveEvalTurn | undefined;
      try {
        turn = await t.send(
          "глянь на госуслугах, нет ли у меня штрафов и налогов. и когда кончается загранник?"
        );
        turn.expectOk();
        checkNoQuestionBeforeCard(t, turn);
        turn.calledTool("browser_task", {
          input: (input: EveEvalToolCall["input"]) =>
            searchStart(
              input,
              (start) =>
                /gosuslugi/iu.test(start.site ?? "") &&
                /штраф/iu.test(start.task) &&
                /налог/iu.test(start.task) &&
                /загран|паспорт/iu.test(start.task)
            ),
        });
      } finally {
        await cancelStartedRuns(turn);
      }
    },
  }),
  defineEval({
    description:
      "Starts «найди билеты … у прохода» as a search with the bag and the seat in it, not a purchase",
    tags: [...tags, "browser"],
    async test(t) {
      await skipWithoutBrowser(t);
      let turn: EveEvalTurn | undefined;
      try {
        turn = await t.send(
          "найди билеты в сочи на пятницу через две недели, утром, обратно в понедельник вечером. с багажом, до 20к туда-обратно, место у прохода. и зарегистрируй меня, как откроется"
        );
        turn.expectOk();
        checkNoQuestionBeforeCard(t, turn);
        // «Найди» is a search: no card before the person picks a flight.
        turn.calledTool("browser_task", {
          input: (input: EveEvalToolCall["input"]) =>
            searchStart(
              input,
              (start) =>
                /проход/iu.test(start.task) && /багаж/iu.test(start.task)
            ),
        });
      } finally {
        await cancelStartedRuns(turn);
      }
    },
  }),
];
