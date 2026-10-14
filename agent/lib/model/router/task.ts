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

/**
 * The model each kind of job goes to; a kind left out keeps the task
 * agent's default (DeepSeek through RunInfra). Claude Haiku 5.5 costs as
 * much input as DeepSeek V4.1 Flash on RouterAI (10.9 ₽ per million tokens
 * on 14.10, cached 1.1 ₽ against 2.2 ₽) at 2.5× the output, and builds
 * decks, documents and code the owner found DeepSeek poor at. A long web
 * research stays on DeepSeek: it reads many pages, and its output is short.
 * TASK_AGENT_ROUTES overrides any of them.
 */
const defaultRoutes: Partial<Record<JobKind, string>> = {
  code: "anthropic/claude-haiku-5.5",
  design: "anthropic/claude-haiku-5.5",
  writing: "anthropic/claude-haiku-5.5",
};

/** Below this the decision model is unsure, and the default model works. */
const minConfidence = 0.6;

/** Where eve's first message to a subagent puts Bro's own text. */
const callerMessageHeading = "\nCaller message:\n";

/** Verdicts by task agent session; more than this and the oldest go. */
const maxRemembered = 1000;
const verdicts = new Map<string, Promise<string>>();

/** The model a kind of job goes to, or `undefined` for the default. */
function routeOf(kind: JobKind) {
  const routes = { ...defaultRoutes, ...env.TASK_AGENT_ROUTES };
  const model = routes[kind]?.trim();
  return model === undefined || model.length === 0 ? undefined : model;
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
 * Bro's. Outside the pilot, or when the decision fails, is unsure or names
 * a kind without a route, the session works on `fallback`. A restart
 * forgets the verdict, and the same first message decides it again.
 */
export async function taskAgentModel(
  scope: { readonly userId?: string; readonly workspaceId: string },
  sessionId: string,
  messages: readonly ModelMessage[],
  fallback: string
) {
  const pilot = env.MODEL_ROUTER_WORKSPACES ?? [];
  if (pilot.length === 0) return fallback;
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
