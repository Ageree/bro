import type { ModelMessage } from "ai";
import { listsWorkspaceRemembered } from "@agent/lib/workspace-list";
import { env } from "@shared/environment";
import { decideKind } from "./decide";

/**
 * The kinds of job Bro hands the task agent, as the decision model reads
 * them. Bro writes the job itself, so it names the deliverable plainly.
 */
const jobKinds = {
  code: "написать или исправить программу или скрипт, обработать, посчитать или проанализировать данные кодом, построить график по данным, перевести файл из одного формата в другой",
  design:
    "сделать презентацию или слайды, документ Word или PDF, оформленный отчёт, инфографику, таблицу Excel с оформлением",
  other: "что-то другое или неясно, что нужно сделать",
  research:
    "исследовать тему по многим страницам в интернете, собрать и сравнить факты из источников",
  writing:
    "написать длинный текст: статью, пост, эссе, речь, резюме, коммерческое предложение",
} as const;

type JobKind = keyof typeof jobKinds;

/** Below this the decision model is unsure, and the default model works. */
const minConfidence = 0.6;

/** Where eve's first message to a subagent puts Bro's own text. */
const callerMessageHeading = "\nCaller message:\n";

/** Verdicts by task agent session; more than this and the oldest go. */
const maxRemembered = 1000;
const verdicts = new Map<string, Promise<string>>();

/**
 * The model each kind of job goes to, from TASK_AGENT_ROUTES; a kind left
 * out, or with an empty model, keeps the task agent's default (DeepSeek
 * through RunInfra). There are no routes of its own: on 14.10 Claude Haiku
 * 5.5 built decks, documents and code no better than DeepSeek in three live
 * jobs (`docs/dev-notes.md`), and the owner kept DeepSeek for everything.
 */
function routeOf(kind: JobKind) {
  const model = env.TASK_AGENT_ROUTES?.[kind]?.trim();
  return model === undefined || model.length === 0 ? undefined : model;
}

/** Whether any kind has a model of its own: without one, nothing to decide. */
function anyRoute() {
  return Object.keys(jobKinds).some(
    (kind) => (env.TASK_AGENT_ROUTES?.[kind]?.trim() ?? "").length > 0
  );
}

/**
 * The job Bro sent the task agent: the session's first message, without the
 * preamble eve wraps it in (`formatSubagentPrompt`).
 */
function jobText(messages: readonly ModelMessage[]) {
  const first = messages.find((message) => message.role === "user");
  if (first === undefined) return undefined;
  const text = Array.isArray(first.content)
    ? first.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
    : first.content;
  const at = text.indexOf(callerMessageHeading);
  const job = at === -1 ? text : text.slice(at + callerMessageHeading.length);
  return job.trim().length === 0 ? undefined : job;
}

async function routedModel(
  sessionId: string,
  messages: readonly ModelMessage[],
  fallback: string
) {
  const job = jobText(messages);
  if (job === undefined) return fallback;
  const decision = await decideKind(job, {
    criteria: jobKinds,
    instructions: "Какую работу поручили? Выбери вид задания.",
  });
  const route =
    decision !== undefined && decision.confidence >= minConfidence
      ? routeOf(decision.kind)
      : undefined;
  console.info("[model-router] task agent", {
    confidence: decision?.confidence,
    kind: decision?.kind,
    model: route ?? fallback,
    ms: decision?.ms,
    sessionId,
  });
  return route ?? fallback;
}

/**
 * The model of a task agent session (MODEL_ROUTER_WORKSPACES, by workspace
 * id or owner's email, or `*`): the decision model reads the job once, at
 * the session's first step, and the session keeps that model to its end,
 * continuations included: a switch would read the whole history again
 * uncached, and a short «поправь третий слайд» reads as no kind at all. It
 * runs in the background, so the second it takes holds up no reply of
 * Bro's. Outside the pilot, without any route, or when the decision fails,
 * is unsure or names a kind without a route, the session works on
 * `fallback`; without routes the decision model is not asked at all. A restart
 * forgets the verdict, and the same first message decides it again.
 */
export async function taskAgentModel(
  scope: { readonly userId?: string; readonly workspaceId: string },
  sessionId: string,
  messages: readonly ModelMessage[],
  fallback: string
) {
  const pilot = env.MODEL_ROUTER_WORKSPACES ?? [];
  if (pilot.length === 0 || !anyRoute()) return fallback;
  const known = verdicts.get(sessionId);
  if (known !== undefined) return known;
  try {
    if (
      !pilot.includes("*") &&
      !(await listsWorkspaceRemembered(pilot, scope))
    ) {
      return fallback;
    }
  } catch (error) {
    console.warn("[model-router] pilot lookup failed", { cause: error });
    return fallback;
  }
  const verdict = routedModel(sessionId, messages, fallback);
  verdicts.set(sessionId, verdict);
  if (verdicts.size > maxRemembered) {
    const oldest = verdicts.keys().next().value;
    if (oldest !== undefined) verdicts.delete(oldest);
  }
  return verdict;
}
