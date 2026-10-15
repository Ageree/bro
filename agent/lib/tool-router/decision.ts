import { alertOwner } from "@agent/lib/owner-alert";
import { type RouterGroup, routerGroups, routerThresholds } from "./questions";
import type { RouterAnswer, RouterFailure } from "./system-one";

/** What the decision model chose, or why there is no choice. */
export type RouterDecision =
  | {
      readonly groups: readonly RouterGroup[];
      readonly inputTokens?: number;
      readonly model: string;
      readonly ms: number;
      readonly outputTokens?: number;
      readonly probabilities: Readonly<Partial<Record<RouterGroup, number>>>;
      readonly provider: "routerai" | "typesafe";
    }
  | {
      readonly failure: RouterFailure | "uncalibrated";
      readonly ms: number;
      readonly model?: string;
    };

/** The thresholds measured for a model, by the name its answer gives. */
function thresholdsOf(model: string) {
  return Object.entries(routerThresholds).find(([name]) => name === model)?.[1];
}

/**
 * The groups an answer offers: each whose question's probability is at
 * least its threshold for the model the answer names — never the one asked
 * for, which a provider may serve under another version. A question left
 * unanswered counts as 0. A model without thresholds is a failure, and the
 * owner hears of it once a day: a new model comes in only with its own
 * thresholds from a run of the evaluation.
 */
export function routerDecision(answer: RouterAnswer): RouterDecision {
  if ("failure" in answer) return answer;
  const thresholds = thresholdsOf(answer.model);
  if (thresholds === undefined) {
    console.warn("[tool-router] uncalibrated model", { model: answer.model });
    alertOwner(
      "tool-router:uncalibrated",
      `Роутер инструментов получил ответ модели ${answer.model}, для которой нет порогов: пока каждый ход видит все инструменты. Нужны пороги из прогона оценки.`,
      { repeatAfterMs: 24 * 60 * 60_000 }
    ).catch(() => {
      console.warn("[tool-router] alert failed");
    });
    return { failure: "uncalibrated", model: answer.model, ms: answer.ms };
  }
  const probability = (group: RouterGroup) => answer.answers.get(group) ?? 0;
  return {
    groups: routerGroups.filter(
      (group) => probability(group) >= thresholds[group]
    ),
    inputTokens: answer.inputTokens,
    model: answer.model,
    ms: answer.ms,
    outputTokens: answer.outputTokens,
    probabilities: Object.fromEntries(
      routerGroups.map((group) => [
        group,
        Math.round(probability(group) * 100) / 100,
      ])
    ),
    provider: answer.provider,
  };
}
