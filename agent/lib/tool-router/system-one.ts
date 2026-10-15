import { fetch, ProxyAgent } from "undici";
import { z } from "zod";
import { modelEndpoint } from "@agent/lib/model/endpoint";
import { alertOwner } from "@agent/lib/owner-alert";
import { env } from "@shared/environment";
import { routerQuestions } from "./questions";

/**
 * The tool router's client of System One: one request of a `noul` question
 * per group. TypeSafe serves Jev 1.14 itself (p50 89–93 ms, p95 116–123 ms
 * from a container, 15.10); RouterAI serves only Jev 1.13 (p50 458 ms, p95
 * 581–711 ms). Neither was measured from the VM in Russia, where the
 * shadow measures them.
 *
 * TypeSafe goes first. When it has not answered in `hedgeAfterMs`, or is
 * held after a failure, the same request goes to RouterAI too, when Bro's
 * direct model is RouterAI's, and the first answer read wins; the other is
 * aborted. Past `waitMs` the turn goes on without an answer.
 */
const hedgeAfterMs = 250;

/** How long TypeSafe is skipped after a timeout, a network error or a 5xx. */
const heldAfterFailureMs = 5 * 60_000;

/** How long after a refusal of the key (401, 402, 403). */
const heldAfterRefusalMs = 60 * 60_000;

/**
 * A refusal, held for the hour and told to the owner: the key (401, 402,
 * 403), or the country of the request (451 — TypeSafe answers it to the VM in
 * Russia, 15.10; `TYPESAFE_PROXY_URL` takes the request out of it).
 */
const refusedStatuses: ReadonlySet<number> = new Set([401, 402, 403, 451]);

const typesafeUrl = "https://api.typesafe.ai/v1/systemone";

// Only TypeSafe's requests use this dispatcher; TLS stays checked through
// the CONNECT tunnel, as AgentMail's.
const typesafeProxy = env.TYPESAFE_PROXY_URL
  ? new ProxyAgent(env.TYPESAFE_PROXY_URL)
  : undefined;

const answerSchema = z.object({
  answers: z.record(
    z.string(),
    z.object({
      noul: z.number().min(0).max(1),
      type: z.literal("noul").optional(),
    })
  ),
  model: z.string().min(1),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
    })
    .partial()
    .optional(),
});

/** Why no answer came. */
export type RouterFailure =
  | "error"
  | "no-provider"
  | "refused"
  | "timeout"
  | "unreadable";

export type RouterAnswer =
  | {
      readonly answers: ReadonlyMap<string, number>;
      readonly inputTokens?: number;
      readonly model: string;
      readonly ms: number;
      readonly outputTokens?: number;
      readonly provider: "routerai" | "typesafe";
    }
  | { readonly failure: RouterFailure; readonly ms: number };

/**
 * TypeSafe's hold in this process: until when it is skipped, and whether a
 * probe is out to lift it.
 */
interface TypesafeHold {
  probing: boolean;
  until: number | undefined;
}

const typesafeHold: TypesafeHold = {
  probing: false,
  until: undefined,
};

/** RouterAI's System One, when Bro's direct model is RouterAI's. */
function routerAiTarget() {
  let endpoint: ReturnType<typeof modelEndpoint>;
  try {
    endpoint = modelEndpoint();
  } catch {
    return undefined;
  }
  if (endpoint?.provider !== "routerai") return undefined;
  return {
    headers: {
      ...endpoint.headers,
      authorization: `Bearer ${endpoint.apiKey}`,
      "content-type": "application/json",
    },
    model: env.TOOL_ROUTER_FALLBACK_MODEL,
    url: `${endpoint.baseURL}/systemone`,
  };
}

function typesafeTarget() {
  const key = env.TYPESAFE_API_KEY;
  if (key === undefined) return undefined;
  return {
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    model: env.TOOL_ROUTER_MODEL,
    url: typesafeUrl,
  };
}

type Target = NonNullable<ReturnType<typeof typesafeTarget>>;

/** One provider's outcome: an answer, or how it failed. */
type Attempt =
  | { readonly answer: z.infer<typeof answerSchema>; readonly ok: true }
  | {
      readonly failure: Exclude<RouterFailure, "no-provider">;
      readonly ok: false;
      readonly status?: number;
    };

async function request(
  target: Target,
  state: string,
  signal: AbortSignal,
  proxy: ProxyAgent | undefined
): Promise<Attempt> {
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(target.url, {
      body: JSON.stringify({
        model: target.model,
        questions: routerQuestions,
        state,
      }),
      dispatcher: proxy,
      headers: target.headers,
      method: "POST",
      signal,
    });
  } catch {
    return { failure: signal.aborted ? "timeout" : "error", ok: false };
  }
  if (!response.ok) {
    // The body is the provider's own words: it never reaches a log.
    await response.body?.cancel().catch(() => undefined);
    return {
      failure: refusedStatuses.has(response.status) ? "refused" : "error",
      ok: false,
      status: response.status,
    };
  }
  try {
    const answer = answerSchema.safeParse(await response.json()).data;
    return answer === undefined
      ? { failure: "unreadable", ok: false }
      : { answer, ok: true };
  } catch {
    return { failure: signal.aborted ? "timeout" : "unreadable", ok: false };
  }
}

/** TypeSafe failed: it is held, and a refused key tells the owner. */
function holdTypesafe(attempt: Attempt, now: number) {
  if (attempt.ok) {
    typesafeHold.until = undefined;
    return;
  }
  console.warn("[tool-router] typesafe failed", {
    reason: attempt.failure,
    status: attempt.status,
  });
  if (attempt.failure === "refused") {
    typesafeHold.until = now + heldAfterRefusalMs;
    alertOwner(
      "tool-router:typesafe-refused",
      `TypeSafe отказал роутеру инструментов (HTTP ${String(attempt.status)}): ключ не принят или кончились деньги. Час роутер спрашивает RouterAI (Jev 1.13), потом пробует TypeSafe снова.`,
      { repeatAfterMs: 24 * 60 * 60_000 }
    ).catch(() => {
      console.warn("[tool-router] alert failed");
    });
    return;
  }
  typesafeHold.until = now + heldAfterFailureMs;
}

/**
 * Asks the router's questions about `state` and waits at most `waitMs`.
 * Never throws: a failure is `{ failure }`. A provider's own words never
 * reach the result or a log.
 */
export async function askRouterQuestions(
  state: string,
  waitMs: number
): Promise<RouterAnswer> {
  const started = Date.now();
  const typesafe = typesafeTarget();
  const routerAi = routerAiTarget();
  if (typesafe === undefined && routerAi === undefined) {
    return { failure: "no-provider", ms: 0 };
  }
  const held = typesafeHold.until !== undefined && started < typesafeHold.until;
  // Past its hold TypeSafe is tried again in the background while RouterAI
  // answers the turn, so the probe never holds up a person's reply.
  const probe =
    typesafe !== undefined &&
    !held &&
    typesafeHold.until !== undefined &&
    routerAi !== undefined;
  if (probe && !typesafeHold.probing) {
    typesafeHold.probing = true;
    const probed = (attempt: Attempt) => {
      holdTypesafe(attempt, Date.now());
    };
    request(typesafe, state, AbortSignal.timeout(10_000), typesafeProxy)
      .then(probed)
      .catch(() => undefined)
      .finally(() => {
        typesafeHold.probing = false;
      });
  }
  const typesafeFirst = typesafe !== undefined && !held && !probe;

  const controller = new AbortController();
  return new Promise<RouterAnswer>((resolve) => {
    let settled = false;
    let typesafePending = false;
    let routerAiPending = false;
    let routerAiStarted = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (answer: RouterAnswer) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      controller.abort();
      resolve(answer);
    };
    const answered = (
      provider: "routerai" | "typesafe",
      answer: z.infer<typeof answerSchema>
    ) => {
      finish({
        answers: new Map(
          Object.entries(answer.answers).map(([name, value]) => [
            name,
            value.noul,
          ])
        ),
        inputTokens: answer.usage?.input_tokens,
        model: answer.model,
        ms: Date.now() - started,
        outputTokens: answer.usage?.output_tokens,
        provider,
      });
    };
    /** Both asked, or the only one, and none answered. */
    const failedAll = (failure: Exclude<RouterFailure, "no-provider">) => {
      if (!typesafePending && !routerAiPending) {
        finish({ failure, ms: Date.now() - started });
      }
    };
    const routerAiDone = (attempt: Attempt) => {
      routerAiPending = false;
      if (settled) return;
      if (attempt.ok) {
        answered("routerai", attempt.answer);
        return;
      }
      console.warn("[tool-router] routerai failed", {
        reason: attempt.failure,
        status: attempt.status,
      });
      failedAll(attempt.failure);
    };
    const typesafeDone = (attempt: Attempt) => {
      typesafePending = false;
      // Aborted because RouterAI answered first: no failure of its own.
      if (settled) return;
      holdTypesafe(attempt, Date.now());
      if (attempt.ok) {
        answered("typesafe", attempt.answer);
        return;
      }
      startRouterAi();
      failedAll(attempt.failure);
    };
    const startRouterAi = () => {
      if (routerAiStarted || routerAi === undefined || settled) return;
      routerAiStarted = true;
      routerAiPending = true;
      void request(routerAi, state, controller.signal, undefined).then(
        routerAiDone
      );
    };
    timers.push(
      setTimeout(() => {
        // TypeSafe never answered in time: a timeout of its own.
        if (typesafePending) {
          holdTypesafe({ failure: "timeout", ok: false }, Date.now());
        }
        finish({ failure: "timeout", ms: Date.now() - started });
      }, waitMs)
    );
    if (typesafeFirst) {
      typesafePending = true;
      void request(typesafe, state, controller.signal, typesafeProxy).then(
        typesafeDone
      );
      timers.push(setTimeout(startRouterAi, hedgeAfterMs));
    } else if (routerAi === undefined) {
      // TypeSafe is held, and there is nothing else to ask.
      finish({ failure: "error", ms: 0 });
    } else {
      startRouterAi();
    }
  });
}
