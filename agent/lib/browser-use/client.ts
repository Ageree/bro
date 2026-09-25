import { z } from "zod";
import { env } from "@shared/environment";

const runStatusSchema = z.enum([
  "queued",
  "dispatching",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

const runCreateResponseSchema = z.object({
  id: z.string().min(1),
  model: z.string(),
  sessionId: z.string().min(1),
  status: runStatusSchema,
});

const runSummarySchema = z.object({
  createdAt: z.string().optional(),
  error: z.string().nullable().optional(),
  id: z.string().min(1),
  result: z.string().nullable().optional(),
  sessionId: z.string().min(1),
  status: runStatusSchema,
  task: z.string(),
  // The files the run saved live here, and every run in a session shares it.
  workspaceId: z.string().nullable().optional(),
});

/**
 * A file the run left in its workspace. The download URL is presigned and
 * dies after sixty seconds, so it is fetched in the same breath as the list.
 */
const workspaceFileSchema = z.object({
  lastModified: z.string(),
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  url: z.string().nullable().optional(),
});

const workspaceFileListSchema = z.object({
  files: z.array(workspaceFileSchema),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().nullable().optional(),
});

const runListSchema = z.object({
  hasMore: z.boolean().optional(),
  nextCursor: z.string().nullable().optional(),
  runs: z.array(runSummarySchema),
});

const runStatusResponseSchema = z.object({ status: runStatusSchema });

const runEventsResponseSchema = z.object({
  events: z.array(
    z.object({
      data: z.record(z.string(), z.json()),
      id: z.number().int(),
      type: z.string(),
    })
  ),
  hasMore: z.boolean().optional(),
  nextAfter: z.number().int().nullable().optional(),
});

const queuedMessageSchema = z.object({
  id: z.number().int(),
  sessionId: z.string().min(1),
  status: z.string(),
});

const profileSchema = z.object({ id: z.string().min(1) });

/**
 * A browser the cloud is running. `cdpUrl` is the debugger endpoint of that
 * very browser: hold it and you drive the page the run is on, which is how a
 * one-time code is typed without waiting for the run's own agent.
 */
const browserSessionSchema = z.object({
  agentSessionId: z.string().nullable().optional(),
  cdpUrl: z.string().nullable().optional(),
  id: z.string().min(1),
  status: z.string(),
});

const browserSessionListSchema = z.object({
  items: z.array(browserSessionSchema),
});

const secretBindingSchema = z.object({
  /** Bare hostnames; a host covers its own subdomains. Browser Use caps this at ten. */
  allowedDomains: z.array(z.string().min(1)).min(1).max(10),
  alias: z.string().min(1),
  source: z.object({
    type: z.literal("inline"),
    value: z.string().min(1),
  }),
});

const customProxySchema = z.object({
  host: z.string().min(1),
  password: z.string().min(1).optional(),
  port: z.number().int().positive().max(65_535),
  username: z.string().min(1).optional(),
});

const createRunInputSchema = z.object({
  customProxy: customProxySchema.optional(),
  maxCostUsd: z.number().positive().optional(),
  model: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  proxyCountryCode: z.string().length(2).optional(),
  secretBindings: z.array(secretBindingSchema).max(10).optional(),
  sessionId: z.string().min(1).optional(),
  task: z.string().min(1),
});

export type BrowserUseRunStatus = z.infer<typeof runStatusSchema>;
export type BrowserUseSecretBinding = z.infer<typeof secretBindingSchema>;
export type BrowserUseCreateRunInput = z.infer<typeof createRunInputSchema>;

/** A Browser Use Cloud reply that was not a 2xx, with enough of the body to act on. */
export class BrowserUseError extends Error {
  readonly status: number;
  /** How long Browser Use asked the caller to wait, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    path: string,
    body: string,
    retryAfterMs?: number
  ) {
    super(`Browser Use ${String(status)} on ${path}: ${body.slice(0, 300)}`);
    this.name = "BrowserUseError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Browser Use has no browser free for another run: the project is at its
 * concurrent-session allowance, or throttled. A run started now would get the
 * same answer, so the errand waits in the queue instead
 * (`agent/lib/browser-use/queue.ts`).
 */
export function browserUseBusy(error: unknown): error is BrowserUseError {
  return error instanceof BrowserUseError && error.status === 429;
}

/**
 * The project has no credits left, or the key hit its spend cap. Nothing
 * starts until the owner tops it up, so the person is told so plainly and the
 * owner is alerted (`agent/lib/browser-use/credits.ts`).
 */
export function browserUseOutOfCredits(
  error: unknown
): error is BrowserUseError {
  return error instanceof BrowserUseError && error.status === 402;
}

export function browserUseConfigured() {
  return env.BROWSER_USE_API_KEY !== undefined;
}

export async function createBrowserUseProfile(name: string, userId: string) {
  return profileSchema.parse(
    await request("POST", "/profiles", JSON.stringify({ name, userId }))
  );
}

export async function createBrowserUseRun(input: BrowserUseCreateRunInput) {
  const {
    customProxy,
    maxCostUsd,
    model,
    profileId,
    proxyCountryCode,
    secretBindings,
    sessionId,
    task,
  } = createRunInputSchema.parse(input);
  return runCreateResponseSchema.parse(
    await request(
      "POST",
      "/runs",
      JSON.stringify({
        browserSettings: { customProxy, profileId, proxyCountryCode },
        maxCostUsd,
        model,
        secretBindings,
        sessionId,
        task,
      })
    )
  );
}

/**
 * The newest run whose task carries this exact line, looked for among the
 * project's most recent runs, newest first. Browser Use takes no idempotency
 * key, so a line written into the task is how a run started just before a
 * crash is found again rather than started twice. A cancelled run was given
 * up on purpose — its errand was stopped or changed meanwhile — and is never
 * adopted.
 */
export async function findRecentBrowserUseRunByTaskLine(
  line: string,
  pages = 3,
  cursor?: string
): Promise<z.infer<typeof runSummarySchema> | undefined> {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor !== undefined) query.set("cursor", cursor);
  const page = runListSchema.parse(
    await request("GET", `/runs?${query.toString()}`)
  );
  const found = page.runs.find(
    (run) => run.status !== "cancelled" && run.task.split("\n").includes(line)
  );
  if (found) return found;
  if (pages <= 1 || !page.hasMore || !page.nextCursor) return undefined;
  return findRecentBrowserUseRunByTaskLine(line, pages - 1, page.nextCursor);
}

export async function readBrowserUseRun(runId: string) {
  return runSummarySchema.parse(
    await request("GET", `/runs/${encodeURIComponent(runId)}`)
  );
}

/**
 * The files under one prefix of a run's workspace, each with its presigned
 * download URL. A single page is enough: the caller keeps a handful of images,
 * and a workspace that grew past a hundred files under the prefix is not one
 * the run was asked to fill.
 */
export async function listBrowserUseWorkspaceFiles(
  workspaceId: string,
  prefix: string
) {
  const query = new URLSearchParams({
    includeUrls: "true",
    limit: "100",
    prefix,
  });
  return workspaceFileListSchema.parse(
    await request(
      "GET",
      `/workspaces/${encodeURIComponent(workspaceId)}/files?${query.toString()}`
    )
  );
}

export async function readBrowserUseRunStatus(runId: string) {
  const { status } = runStatusResponseSchema.parse(
    await request("GET", `/runs/${encodeURIComponent(runId)}/status`)
  );
  return status;
}

export async function listBrowserUseRunEvents(runId: string, limit = 100) {
  return runEventsResponseSchema.parse(
    await request(
      "GET",
      `/runs/${encodeURIComponent(runId)}/events?limit=${String(limit)}`
    )
  );
}

export async function queueBrowserUseSessionMessage(
  sessionId: string,
  text: string
) {
  return queuedMessageSchema.parse(
    await request(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/queue`,
      JSON.stringify({ text })
    )
  );
}

/**
 * The debugger endpoint of the browser this run's session is using, when one
 * is still up. A finished run does not close its browser — the cloud keeps it
 * until it is stopped or hits the four-hour cap — so a code can still be typed
 * into the page the person is looking at.
 */
export async function findBrowserUseSessionCdpUrl(sessionId: string) {
  const { items } = browserSessionListSchema.parse(
    await request("GET", "/browsers")
  );
  const browser = items.find(
    (item) => item.agentSessionId === sessionId && item.status === "active"
  );
  return browser?.cdpUrl ?? undefined;
}

const sessionInfoSchema = z.object({
  latestRunId: z.string().min(1),
  status: runStatusSchema,
});

/**
 * Stop every live browser a session holds, once the run that just settled is
 * still the session's latest and it has ended. A profile keeps the cookies of
 * the browsers that ran on it — the sign-ins and the trust a site handed out
 * after a passed check — and stopping the browser is what hands them back to
 * the profile now rather than whenever the idle cleanup gets to it. A
 * follow-up that started in the same session in the meantime owns the browser
 * now, and keeps it.
 */
export async function stopBrowserUseSessionBrowsers(
  sessionId: string,
  settledRunId: string
) {
  const session = sessionInfoSchema.parse(
    await request("GET", `/sessions/${encodeURIComponent(sessionId)}`)
  );
  if (
    session.latestRunId !== settledRunId ||
    !["cancelled", "completed", "failed"].includes(session.status)
  ) {
    return 0;
  }
  const { items } = browserSessionListSchema.parse(
    await request("GET", "/browsers")
  );
  const live = items.filter(
    (item) => item.agentSessionId === sessionId && item.status === "active"
  );
  await Promise.all(
    live.map((item) =>
      request(
        "PATCH",
        `/browsers/${encodeURIComponent(item.id)}`,
        JSON.stringify({ action: "stop" })
      )
    )
  );
  return live.length;
}

export async function cancelBrowserUseRun(runId: string) {
  return runSummarySchema.parse(
    await request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, "{}")
  );
}

export async function stopBrowserUseSession(sessionId: string) {
  await request("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
}

/**
 * The `browser.ready` event carries the live browser's takeover URL, which is
 * the only way a person can solve a CAPTCHA or a 3-D Secure step for a run.
 * Treat it as a credential: anyone holding it drives the same browser.
 */
export function liveViewUrlFromEvents(
  events: z.infer<typeof runEventsResponseSchema>["events"]
) {
  for (const event of events) {
    if (event.type !== "browser.ready") continue;
    const url = z.url().safeParse(event.data.live_view_url);
    if (url.success) return url.data;
  }
  return undefined;
}

/** A status or summary read takes well under a second. */
const browserUseRequestTimeoutMs = 30_000;

async function request(
  method: "DELETE" | "GET" | "PATCH" | "POST",
  path: string,
  body?: string
) {
  const apiKey = env.BROWSER_USE_API_KEY;
  if (!apiKey) throw new Error("BROWSER_USE_API_KEY is not configured.");
  const url = new URL(
    `${env.BROWSER_USE_BASE_URL.replace(/\/+$/u, "")}${path}`
  );
  const init: RequestInit = {
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "X-Browser-Use-API-Key": apiKey,
    },
    method,
  };
  if (body !== undefined) init.body = body;

  // A read, a stop or a cancel is bounded: an answer that never came used to
  // hold the poller's tick for undici's five minutes. A POST is not: Browser
  // Use takes no idempotency key, so one cut off after it started a run or
  // queued a message leaves that run acting for the person with no row, no
  // report and nothing to cancel it, and the retry opens a second browser.
  // The poller does not wait on it longer than its own deadlines anyway
  // (`within` in `agent/schedules/browser-runs.ts`).
  const attempt = () =>
    fetch(
      url,
      method === "POST"
        ? init
        : { ...init, signal: AbortSignal.timeout(browserUseRequestTimeoutMs) }
    );
  let response = await attempt();
  // One retry only, and only for a read or a request that is safe to repeat.
  // A POST that failed may still have started a run or queued a message, and
  // a 429 on one is the concurrent-session cap, which the next second does
  // not lift: the caller queues the errand instead of hammering the API.
  if (
    method !== "POST" &&
    (response.status === 429 || response.status >= 500)
  ) {
    response = await attempt();
  }
  const text = await response.text();
  if (!response.ok) {
    throw new BrowserUseError(
      response.status,
      path,
      text,
      throttleWaitMs(response.headers.get("retry-after"), text)
    );
  }
  if (!text) return {};
  return parseJson(text, path, response.status);
}

const retryAfterBodySchema = z.object({
  retry_after_seconds: z.number().nonnegative(),
});

/**
 * The wait a throttled reply asked for: `retry_after_seconds` in a project
 * throttle's body, or the `Retry-After` header an edge throttle sends — in
 * seconds or as an HTTP date, both of which the header allows.
 */
function throttleWaitMs(header: string | null, body: string) {
  let seconds: number | undefined;
  try {
    seconds = retryAfterBodySchema.safeParse(JSON.parse(body)).data
      ?.retry_after_seconds;
  } catch {
    seconds = undefined;
  }
  if (seconds !== undefined) return seconds * 1_000;
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/u.test(value)) return Number(value) * 1_000;
  const until = Date.parse(value);
  return Number.isNaN(until) ? undefined : Math.max(until - Date.now(), 0);
}

function parseJson(text: string, path: string, status: number) {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    throw new BrowserUseError(status, path, text);
  }
}
