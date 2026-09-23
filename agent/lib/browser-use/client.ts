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
  model: z.string().optional().catch(undefined),
  result: z.string().nullable().optional(),
  sessionId: z.string().min(1),
  status: runStatusSchema,
  task: z.string(),
  totalCostUsd: z.union([z.string(), z.number()]).optional().catch(undefined),
  totalInputTokens: z.number().int().nonnegative().optional().catch(undefined),
  totalOutputTokens: z.number().int().nonnegative().optional().catch(undefined),
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

const runStatusResponseSchema = z.object({ status: runStatusSchema });

const recoveryRunSchema = runSummarySchema.pick({
  id: true,
  sessionId: true,
  status: true,
  task: true,
});

const runListResponseSchema = z.object({
  hasMore: z.boolean().default(false),
  nextCursor: z.string().nullable().optional(),
  runs: z.array(runSummarySchema),
});

const runEventsResponseSchema = z.object({
  events: z.array(
    z.object({
      data: z.record(z.string(), z.json()),
      id: z.number().int(),
      ts: z.string().optional(),
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
  pageNumber: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  totalItems: z.number().int().nonnegative().optional(),
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

  constructor(status: number, path: string, body: string) {
    super(`Browser Use ${String(status)} on ${path}: ${body.slice(0, 300)}`);
    this.name = "BrowserUseError";
    this.status = status;
  }
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
  const path = `/runs/${encodeURIComponent(runId)}/status`;
  const visibilityRetryDelaysMs = [250, 500, 750, 1_000, 500] as const;
  const attemptDelaysMs = [0, ...visibilityRetryDelaysMs];
  const deadline = Date.now() + 3_000;
  const attemptStatus = async (
    attempt: number,
    lastNotFound?: BrowserUseError
  ): Promise<BrowserUseRunStatus> => {
    const throwGraceFailure = (): never => {
      if (lastNotFound) throw lastNotFound;
      throw new Error("Browser Use run status visibility grace expired.");
    };
    const delayMs = attemptDelaysMs[attempt];
    if (delayMs === undefined || (attempt > 0 && Date.now() >= deadline))
      return throwGraceFailure();
    if (delayMs > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return throwGraceFailure();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(delayMs, remainingMs))
      );
      if (Date.now() >= deadline) return throwGraceFailure();
    }
    try {
      const { status } = runStatusResponseSchema.parse(
        await request("GET", path, undefined, {
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        })
      );
      return status;
    } catch (error) {
      if (
        !(error instanceof BrowserUseError) ||
        error.status !== 404 ||
        attempt === attemptDelaysMs.length - 1
      )
        throw error;
      return attemptStatus(attempt + 1, error);
    }
  };
  return attemptStatus(0);
}

export async function listBrowserUseRunsBySession(
  sessionId: string
): Promise<z.infer<typeof recoveryRunSchema>[]> {
  return listBrowserUseRunPage(sessionId);
}

async function listBrowserUseRunPage(
  sessionId: string,
  cursor?: string,
  collected: z.infer<typeof recoveryRunSchema>[] = []
): Promise<z.infer<typeof recoveryRunSchema>[]> {
  const query = new URLSearchParams({ sessionId, limit: "25" });
  if (cursor) query.set("cursor", cursor);
  const page = runListResponseSchema.parse(
    await request("GET", `/runs?${query.toString()}`)
  );
  const matching = page.runs
    .filter((run) => run.sessionId === sessionId)
    .map((run) => recoveryRunSchema.parse(run));
  const runs = [...collected, ...matching].slice(0, 50);
  const nextCursor = page.hasMore ? (page.nextCursor ?? undefined) : undefined;
  if (runs.length === 50 || !nextCursor) return runs;
  return listBrowserUseRunPage(sessionId, nextCursor, runs);
}

export async function listBrowserUseRunEvents(
  runId: string,
  limit = 100,
  after = 0
) {
  return runEventsResponseSchema.parse(
    await request(
      "GET",
      `/runs/${encodeURIComponent(runId)}/events?limit=${String(limit)}&after=${String(after)}`
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
export async function findBrowserUseSessionCdpUrl(
  sessionId: string,
  signal?: AbortSignal
) {
  const { items } = browserSessionListSchema.parse(
    await request(
      "GET",
      `/browsers?agentSessionId=${encodeURIComponent(sessionId)}&filterBy=active&pageSize=100&pageNumber=1`,
      undefined,
      { signal }
    )
  );
  const browser = items.find(
    (item) => item.agentSessionId === sessionId && item.status === "active"
  );
  return browser?.cdpUrl ?? undefined;
}

export async function cancelBrowserUseRun(runId: string) {
  return runSummarySchema.parse(
    await request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, "{}", {
      retry: true,
    })
  );
}

export async function stopBrowserUseSession(sessionId: string) {
  const browsers = await listActiveBrowserUseSessions(sessionId);
  await Promise.all(
    browsers.map((browser) =>
      request(
        "PATCH",
        `/browsers/${encodeURIComponent(browser.id)}`,
        JSON.stringify({ action: "stop" })
      )
    )
  );
  await request("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
}

async function listActiveBrowserUseSessions(
  agentSessionId: string,
  pageNumber = 1,
  collected: z.infer<typeof browserSessionSchema>[] = []
): Promise<z.infer<typeof browserSessionSchema>[]> {
  const page = browserSessionListSchema.parse(
    await request(
      "GET",
      `/browsers?agentSessionId=${encodeURIComponent(agentSessionId)}&filterBy=active&pageSize=100&pageNumber=${String(pageNumber)}`
    )
  );
  const matching = page.items.filter(
    (item) => item.agentSessionId === agentSessionId && item.status === "active"
  );
  const items = [...collected, ...matching];
  const hasNextPage =
    page.totalItems === undefined
      ? page.items.length === 100
      : pageNumber * (page.pageSize ?? 100) < page.totalItems;
  if (!hasNextPage) return items;
  return listActiveBrowserUseSessions(agentSessionId, pageNumber + 1, items);
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

async function request(
  method: "DELETE" | "GET" | "PATCH" | "POST",
  path: string,
  body?: string,
  controls: { retry?: boolean; signal?: AbortSignal } = {}
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
    signal: controls.signal,
  };
  if (body !== undefined) init.body = body;

  let response = await fetch(url, init);
  // One retry only. Browser Use throttles per project, and a second failure
  // means the caller should surface the problem rather than queue more load.
  const retry = controls.retry ?? (method === "GET" || method === "PATCH");
  if (retry && (response.status === 429 || response.status >= 500)) {
    response = await fetch(url, init);
  }
  const text = await response.text();
  if (!response.ok) throw new BrowserUseError(response.status, path, text);
  if (!text) return {};
  return parseJson(text, path, response.status);
}

function parseJson(text: string, path: string, status: number) {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    throw new BrowserUseError(status, path, text);
  }
}
