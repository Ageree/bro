import { z } from "zod";
import { modelEndpoint } from "@agent/lib/model/endpoint";
import { env } from "@shared/environment";

/**
 * Jev answered 15 Russian requests in 0.7–1.6 s (median 0.9–1.2 s,
 * 14.10); past this the router keeps the default model rather than hold
 * the work.
 */
const decisionTimeoutMs = 4000;
/** Enough of a job to tell its kind; the decision model bills its input. */
const maxStateCharacters = 4000;

const decisionSchema = z.object({
  answers: z.object({
    kind: z.object({
      choice: z.string(),
      confidence: z.number(),
    }),
  }),
});

/** Whether the model chose one of the options it was given. */
function oneOf<Kind extends string>(
  criteria: Readonly<Record<Kind, string>>,
  choice: string | undefined
): choice is Kind {
  return choice !== undefined && Object.hasOwn(criteria, choice);
}

/**
 * Which of `criteria` fits `state`, by the decision model of RouterAI's
 * System One API (MODEL_ROUTER_MODEL, TypeSafe's Jev by default): one
 * forward pass that returns a calibrated probability per option instead of
 * generated text, about 0.004 ₽ a call. `undefined` when no direct model
 * is configured or the call failed or ran late: the caller keeps its
 * default.
 */
export async function decideKind<const Kind extends string>(
  state: string,
  question: {
    readonly criteria: Readonly<Record<Kind, string>>;
    readonly instructions: string;
  }
) {
  const endpoint = modelEndpoint();
  if (endpoint === undefined) return undefined;
  const started = Date.now();
  try {
    const response = await fetch(`${endpoint.baseURL}/systemone`, {
      body: JSON.stringify({
        model: env.MODEL_ROUTER_MODEL,
        questions: {
          kind: {
            criteria: question.criteria,
            instructions: question.instructions,
            type: "choice",
          },
        },
        state: state.slice(0, maxStateCharacters),
      }),
      headers: {
        ...endpoint.headers,
        authorization: `Bearer ${endpoint.apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(decisionTimeoutMs),
    });
    if (!response.ok) {
      console.warn("[model-router] decision failed", {
        ms: Date.now() - started,
        status: response.status,
      });
      return undefined;
    }
    const answer = decisionSchema.safeParse(await response.json()).data?.answers
      .kind;
    const kind = answer?.choice;
    if (answer === undefined || !oneOf(question.criteria, kind)) {
      console.warn("[model-router] decision unreadable", {
        ms: Date.now() - started,
      });
      return undefined;
    }
    return { confidence: answer.confidence, kind, ms: Date.now() - started };
  } catch (error) {
    console.warn("[model-router] decision failed", {
      ms: Date.now() - started,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
}
