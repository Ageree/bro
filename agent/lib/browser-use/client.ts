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
  error: z.string().nullable().optional(),
  id: z.string().min(1),
  result: z.string().nullable().optional(),
  sessionId: z.string().min(1),
  status: runStatusSchema,
  task: z.string(),
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

async function request(
  method: "DELETE" | "GET" | "POST",
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

  let response = await fetch(url, init);
  // One retry only. Browser Use throttles per project, and a second failure
  // means the caller should surface the problem rather than queue more load.
  if (response.status === 429 || response.status >= 500) {
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
