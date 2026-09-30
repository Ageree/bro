import { z } from "zod";
import { browserSandboxWorkerOrigin } from "@agent/lib/browser-pool/host";
import type { browserVms } from "@db/schema/browser-vms";
import { signBrowserVmToken } from "./token";

/**
 * The HTTP client of the worker on a workspace's browser VM
 * (`browser-vm/worker/worker.py`, the source of truth for every shape here).
 * Each call but the health check carries a fresh token signed for that VM
 * and its current generation.
 */

/**
 * The columns of a `browser_vms` row a call needs: where the worker answers,
 * and what its tokens are signed for. A VM whose address is not known yet has
 * no worker to call. A sandbox of the pool (docs/browser-pool.md) runs the
 * same worker behind its host's address, under `/g/<sandbox id>`:
 * `sandboxState` says it is one, and `hostId` which host holds it (both
 * absent or null on a workspace's own VM).
 */
type BrowserVmTarget = Readonly<
  Pick<typeof browserVms.$inferSelect, "generation" | "host" | "workspaceId"> &
    Partial<Pick<typeof browserVms.$inferSelect, "hostId" | "sandboxState">>
>;

/** The health check is a liveness probe: an answer slower than this is none. */
const healthTimeoutMs = 5_000;
const readTimeoutMs = 15_000;
const writeTimeoutMs = 30_000;
// Setting the proxy waits for the exit lookup through it (up to 20 s) and may
// start Chrome (up to 30 s); resetting the profile or controlling Chrome waits
// up to 30 s for Chrome to come back. Cut off sooner, a call that succeeded
// would read as failed.
const slowWriteTimeoutMs = 60_000;

const runStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

const healthSchema = z.object({
  busy: z.boolean(),
  chrome: z.boolean(),
  /** Whether cloud-init handed the worker its environment id and key. */
  configured: z.boolean(),
  generation: z.number().int(),
  image: z.string().nullable(),
  /** Whether the residential proxy is set; until it is, Chrome has no network. */
  proxy: z.boolean(),
  stage: z.string().nullable(),
  uptimeSeconds: z.number(),
  worker: z.string(),
});

// The exit is what ipinfo.io saw through the proxy, and how fast a megabyte
// came through it. One object, since a probe that failed keeps the rest: an
// address with a failed speed probe is still an address.
const proxyExitSchema = z.object({
  city: z.string().nullish(),
  country: z.string().nullish(),
  /** Why ipinfo.io could not be asked through the exit: no address then. */
  error: z.string().nullish(),
  ip: z.string().nullish(),
  /** Time of the ipinfo.io answer through the exit. */
  latencyMs: z.number().nullish(),
  /** Speed of a megabyte downloaded through the exit. */
  mbps: z.number().nullish(),
  org: z.string().nullish(),
  region: z.string().nullish(),
  /** Why the megabyte did not come through: the speed is unknown then. */
  speedError: z.string().nullish(),
});

const proxySetupSchema = z.object({
  chrome: z.boolean(),
  exit: proxyExitSchema,
  traffic: z.object({
    connections: z.number(),
    down: z.number(),
    refused: z.number(),
    up: z.number(),
  }),
  vmAddress: z.string().nullable(),
});

// Steps are the worker's own summary for diagnosis; nothing in Bro acts on
// their details, so an odd step must not make the whole run unreadable.
const stepSchema = z.object({
  actions: z
    .array(z.object({ action: z.string(), index: z.number().nullish() }))
    .nullish(),
  at: z.string().nullish(),
  goal: z.string().nullish(),
  number: z.number().nullish(),
  title: z.string().nullish(),
  url: z.string().nullish(),
});

const runSummarySchema = z.object({
  createdAt: z.string(),
  engine: z.string(),
  error: z.string().nullable(),
  finalTitle: z.string().nullable(),
  finalUrl: z.string().nullable(),
  finishedAt: z.string().nullable(),
  id: z.string().min(1),
  jev: z.record(z.string(), z.json()).nullable(),
  result: z.string().nullable(),
  sessionId: z.string().min(1),
  startedAt: z.string().nullable(),
  status: runStatusSchema,
  stepCount: z.number().int().nonnegative(),
  success: z.boolean().nullable(),
  task: z.string(),
  /**
   * Bytes the run moved through the residential proxy, once it has ended.
   * Absent from a worker older than the field.
   */
  traffic: z
    .object({ down: z.number().nonnegative(), up: z.number().nonnegative() })
    .nullish(),
  /**
   * Messages queued into the run (`sendBrowserVmWorkerMessage`, answered
   * `queued`) that the agent never read before it settled. The worker never
   * starts a follow-up on its own; whoever reads this run and still tracks
   * it starts one itself so their outcome is not lost. Optional: an older
   * worker mid-rollout may not send it at all.
   */
  unreadMessages: z.array(z.string()).optional(),
  usage: z.record(z.string(), z.json()).nullable(),
});

const runSchema = runSummarySchema.extend({ steps: z.array(stepSchema) });

const runListSchema = z.object({ runs: z.array(runSummarySchema) });

const runStartSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  status: runStatusSchema,
});

const busySchema = z.object({
  error: z.literal("busy"),
  runId: z.string().min(1),
});

/** The model the VM's agent calls, sent with every run: the VM keeps no key. */
const llmSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().min(1),
  model: z.string().min(1),
});

const runInputSchema = z.object({
  /** A slider puzzle the worker cannot place goes to 2Captcha with this key. */
  captcha: z.object({ twoCaptchaKey: z.string().min(1) }).optional(),
  engine: z.enum(["agent", "jev-then-agent"]).optional(),
  /** Start the session's agent memory over instead of continuing it. */
  freshMemory: z.boolean().optional(),
  /** Bro's own run id: a start repeated with it adopts the run it began. */
  id: z.string().min(1),
  llm: llmSchema,
  maxSteps: z.number().int().positive().optional(),
  /** Typed only on the sites named, as a Browser Use secret binding was. */
  secrets: z
    .array(
      z.object({
        alias: z.string().min(1),
        allowedDomains: z.array(z.string().min(1)).min(1).max(10),
        value: z.string().min(1),
      })
    )
    .max(10)
    .optional(),
  sessionId: z.string().min(1).optional(),
  task: z.string().min(1),
  timeoutSeconds: z.number().int().positive().optional(),
});

const sessionSchema = z.object({
  id: z.string().min(1),
  latestRunId: z.string().nullable(),
  status: z.enum(["idle", "running"]),
  /** Whether the errand's page is still kept in its tab. */
  tabOpen: z.boolean(),
});

const sessionMessageSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  /** `queued`: the live run reads it before its next step. `started`: a follow-up run. */
  status: z.enum(["queued", "started"]),
});

const releaseSchema = z.object({ status: z.enum(["running", "stopped"]) });

const fileListSchema = z.object({
  files: z.array(
    z.object({
      lastModified: z.string(),
      path: z.string().min(1),
      size: z.number().int().nonnegative(),
    })
  ),
});

const chromeControlSchema = z.object({
  chrome: z.boolean(),
  output: z.string(),
  rc: z.number().int().nullable(),
});

const profileResetSchema = z.object({
  chrome: z.boolean(),
  reset: z.boolean(),
});

const tabSchema = z.object({ targetId: z.string().min(1) });

const closedTabSchema = z.object({ closed: z.string() });

const parkedSchema = z.object({ parked: z.literal(true) });

const workerUpdateSchema = z.object({ updated: z.literal(true) });

/** A worker reply that was not a 2xx, with enough of the body to act on. */
export class BrowserVmWorkerError extends Error {
  readonly status: number;
  readonly body: string;
  /**
   * The run holding the VM's one browser, when a start was refused because
   * the browser is busy with it: the caller tells a follow-up of that very
   * errand from another errand that has to wait its turn.
   */
  readonly busyRunId: string | undefined;

  constructor(status: number, path: string, body: string) {
    super(
      `Browser VM worker ${String(status)} on ${path}: ${body.slice(0, 300)}`
    );
    this.name = "BrowserVmWorkerError";
    this.status = status;
    this.body = body;
    this.busyRunId = status === 409 ? busyRunId(body) : undefined;
  }
}

function busyRunId(body: string) {
  try {
    return busySchema.safeParse(JSON.parse(body)).data?.runId;
  } catch {
    return undefined;
  }
}

/** Liveness, Chrome and the proxy, without a token and without secrets. */
export async function readBrowserVmWorkerHealth(vm: BrowserVmTarget) {
  return healthSchema.parse(
    await request(vm, "GET", "/v1/health", {
      signed: false,
      timeoutMs: healthTimeoutMs,
    })
  );
}

/**
 * Point the VM's Chrome at the residential proxy and learn where it exits.
 * Until this is done the worker refuses Chrome every connection, so a site
 * never sees the VM's own datacenter address.
 */
export async function setBrowserVmWorkerProxy(
  vm: BrowserVmTarget,
  proxy: {
    readonly host: string;
    readonly password: string;
    readonly port: number;
    readonly username: string;
  }
) {
  return proxySetupSchema.parse(
    await request(vm, "POST", "/v1/session", {
      body: { proxy },
      timeoutMs: slowWriteTimeoutMs,
    })
  );
}

/**
 * The VM's runs whose task carries this exact line, newest first: how a run
 * whose start lost its answer is found again rather than started twice.
 */
export async function listBrowserVmWorkerRuns(
  vm: BrowserVmTarget,
  line: string
) {
  const query = new URLSearchParams({ contains: line });
  return runListSchema.parse(
    await request(vm, "GET", `/v1/runs?${query.toString()}`, {
      timeoutMs: readTimeoutMs,
    })
  ).runs;
}

/**
 * Start an agent run. The worker is idempotent on the run id, so a start
 * repeated after a lost answer adopts the run instead of starting a second.
 * A browser busy with another run answers 409 with that run (`busyRunId`).
 */
export async function startBrowserVmWorkerRun(
  vm: BrowserVmTarget,
  input: z.input<typeof runInputSchema>
) {
  return runStartSchema.parse(
    await request(vm, "POST", "/v1/runs", {
      body: runInputSchema.parse(input),
      timeoutMs: writeTimeoutMs,
    })
  );
}

/** The run with its latest steps, or undefined when the worker never had it. */
export async function readBrowserVmWorkerRun(
  vm: BrowserVmTarget,
  runId: string
) {
  return readOrMissing(async () =>
    runSchema.parse(
      await request(vm, "GET", `/v1/runs/${encodeURIComponent(runId)}`, {
        timeoutMs: readTimeoutMs,
      })
    )
  );
}

/** Stop the agent; the page it was on stays in its tab. */
export async function cancelBrowserVmWorkerRun(
  vm: BrowserVmTarget,
  runId: string
) {
  return runSchema.parse(
    await request(vm, "POST", `/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      timeoutMs: writeTimeoutMs,
    })
  );
}

/** A session's latest run and whether its tab is kept, or undefined. */
export async function readBrowserVmWorkerSession(
  vm: BrowserVmTarget,
  sessionId: string
) {
  return readOrMissing(async () =>
    sessionSchema.parse(
      await request(
        vm,
        "GET",
        `/v1/sessions/${encodeURIComponent(sessionId)}`,
        { timeoutMs: readTimeoutMs }
      )
    )
  );
}

/**
 * A message into a session: the live run reads it before its next step, or
 * an idle session starts a follow-up run under `runId` in the same tab. The
 * model goes with it every time, since a restarted worker forgot the one the
 * session had and would refuse the follow-up.
 */
export async function sendBrowserVmWorkerMessage(
  vm: BrowserVmTarget,
  sessionId: string,
  message: {
    readonly llm: z.input<typeof llmSchema>;
    readonly runId?: string;
    readonly text: string;
  }
) {
  return sessionMessageSchema.parse(
    await request(
      vm,
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { body: message, timeoutMs: writeTimeoutMs }
    )
  );
}

/** Close a session's tab once its run has ended; `running` while it has not. */
export async function releaseBrowserVmWorkerSession(
  vm: BrowserVmTarget,
  sessionId: string
) {
  return releaseSchema.parse(
    await request(
      vm,
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/release`,
      { timeoutMs: writeTimeoutMs }
    )
  ).status;
}

/** The files a session's runs saved under a prefix, newest first. */
export async function listBrowserVmWorkerFiles(
  vm: BrowserVmTarget,
  sessionId: string,
  prefix: string
) {
  const query = new URLSearchParams({ prefix, session: sessionId });
  return fileListSchema.parse(
    await request(vm, "GET", `/v1/files?${query.toString()}`, {
      timeoutMs: readTimeoutMs,
    })
  ).files;
}

/**
 * A URL that downloads one saved file with a plain GET, as a Browser Use
 * presigned URL did: the token rides in the path, is scoped to the session
 * and lives two minutes.
 */
export function browserVmFileUrl(
  vm: BrowserVmTarget,
  sessionId: string,
  path: string
) {
  const token = signBrowserVmToken({
    generation: vm.generation,
    session: sessionId,
    ttlSeconds: 120,
    workspaceId: vm.workspaceId,
  });
  const segments = path.split("/").map(encodeURIComponent).join("/");
  return `${origin(vm)}/v1/dl/${token}/${encodeURIComponent(sessionId)}/${segments}`;
}

/**
 * Stop, start or restart the VM's Chrome. A clean stop is what writes its
 * cookies to the profile before the VM is powered off.
 */
export async function controlBrowserVmWorkerChrome(
  vm: BrowserVmTarget,
  action: "restart" | "start" | "stop"
) {
  return chromeControlSchema.parse(
    await request(vm, "POST", `/v1/browser/${action}`, {
      timeoutMs: slowWriteTimeoutMs,
    })
  );
}

/** Wipe the Chrome profile: every sign-in and cookie is forgotten. */
export async function resetBrowserVmWorkerProfile(vm: BrowserVmTarget) {
  return profileResetSchema.parse(
    await request(vm, "POST", "/v1/profile/reset", {
      timeoutMs: slowWriteTimeoutMs,
    })
  );
}

/**
 * Before a sandbox of the pool is frozen: the worker drops the model key, the
 * proxy login and the sites' secrets it holds, which the snapshot would keep.
 * It refuses (409) while a run is open, so a park never catches a run. After
 * the restore Bro sends them again, as after a worker restart.
 */
export async function parkBrowserVmWorker(vm: BrowserVmTarget) {
  parkedSchema.parse(
    await request(vm, "POST", "/v1/park", { timeoutMs: writeTimeoutMs })
  );
}

/**
 * Replace the worker's own code with `code` (the whole of
 * `browser-vm/worker/worker.py`). The worker checks the checksum, runs the
 * new file's top-level code in a separate Python (its imports at the top,
 * and, in a file that has `CANDIDATE_IMPORTS`, the lazy browser-use, OpenCV
 * and numpy imports too), refuses (409) while a run holds the
 * browser, and then exits for systemd to start the new code: the new
 * version shows in the health check seconds later, or the old one after a
 * rollback. That a version answers proves only that it starts.
 */
export async function updateBrowserVmWorkerCode(
  vm: BrowserVmTarget,
  code: Uint8Array<ArrayBuffer>,
  sha256: string,
  timeoutMs = slowWriteTimeoutMs
) {
  workerUpdateSchema.parse(
    await request(vm, "POST", "/v1/admin/worker", {
      file: { bytes: code, headers: { "x-content-sha256": sha256 } },
      // The load check starts a Python and, with a candidate that checks its
      // lazy imports, loads browser-use: seconds on a VM.
      timeoutMs,
    })
  );
}

/** A blank tab of its own for a keep-alive visit; its target id comes back. */
export async function openBrowserVmWorkerTab(vm: BrowserVmTarget) {
  return tabSchema.parse(
    await request(vm, "POST", "/v1/tabs", { timeoutMs: writeTimeoutMs })
  ).targetId;
}

/** Close a keep-alive tab. The worker refuses to close an errand's tab. */
export async function closeBrowserVmWorkerTab(
  vm: BrowserVmTarget,
  targetId: string
) {
  closedTabSchema.parse(
    await request(vm, "DELETE", `/v1/tabs/${encodeURIComponent(targetId)}`, {
      timeoutMs: writeTimeoutMs,
    })
  );
}

/**
 * The CDP endpoint of the VM's Chrome, in the form
 * `agent/lib/browser-use/cdp.ts` takes from Browser Use: a WebSocket base
 * whose HTTP form lists the targets. The worker lists first the tab of the
 * session, or the keep-alive tab, the token is scoped to, and the CDP client
 * types into the first page it lists. The token lives five minutes, enough to
 * connect; an open socket outlives it.
 */
export function browserVmCdpUrl(
  vm: BrowserVmTarget,
  focus: { readonly sessionId: string } | { readonly targetId: string }
) {
  const token = signBrowserVmToken({
    generation: vm.generation,
    session: "sessionId" in focus ? focus.sessionId : `b:${focus.targetId}`,
    workspaceId: vm.workspaceId,
  });
  return `${origin(vm).replace(/^https:/u, "wss:")}/v1/cdp/${token}`;
}

/**
 * The worker's HTTPS origin. Caddy on the VM holds a certificate for the
 * address's sslip.io name, which resolves to the address itself, so no DNS
 * record is kept per VM. A sandbox's worker answers on its host's name under
 * `/g/<sandbox id>`, which the host's Caddy strips before the worker.
 */
function origin(vm: BrowserVmTarget) {
  const { host } = vm;
  if (host === null || !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) {
    throw new Error("The browser VM has no public IPv4 address yet.");
  }
  if (vm.hostId !== undefined && vm.hostId !== null) {
    return browserSandboxWorkerOrigin(
      { address: host, id: vm.hostId },
      vm.workspaceId
    );
  }
  // A sandbox whose host record went keeps the host's old address, which
  // Cloud.ru may have given to another VM: nothing goes there.
  if (vm.sandboxState !== undefined && vm.sandboxState !== null) {
    throw new Error("The browser sandbox is on no host.");
  }
  return `https://${host.replaceAll(".", "-")}.sslip.io`;
}

async function readOrMissing<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof BrowserVmWorkerError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function request(
  vm: BrowserVmTarget,
  method: "DELETE" | "GET" | "POST",
  path: string,
  options: {
    readonly body?: unknown;
    /** A file sent as it is instead of a JSON body, with its own headers. */
    readonly file?: {
      readonly bytes: Uint8Array<ArrayBuffer>;
      readonly headers: Readonly<Record<string, string>>;
    };
    readonly signed?: boolean;
    readonly timeoutMs: number;
  }
) {
  const headers = new Headers({ accept: "application/json" });
  if (options.signed !== false) {
    const token = signBrowserVmToken({
      generation: vm.generation,
      workspaceId: vm.workspaceId,
    });
    headers.set("authorization", `Bearer ${token}`);
  }
  const init: RequestInit = {
    headers,
    method,
    signal: AbortSignal.timeout(options.timeoutMs),
  };
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  if (options.file !== undefined) {
    headers.set("content-type", "application/octet-stream");
    for (const [name, value] of Object.entries(options.file.headers)) {
      headers.set(name, value);
    }
    init.body = options.file.bytes;
  }
  // No retry here: every caller knows better whether a repeat is safe, and a
  // start that lost its answer is looked up by its id instead.
  const response = await fetch(`${origin(vm)}${path}`, init);
  // The query of a run lookup carries a task line: kept out of errors.
  const route = path.split("?")[0] ?? path;
  const text = await response.text();
  if (!response.ok)
    throw new BrowserVmWorkerError(response.status, route, text);
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    throw new BrowserVmWorkerError(response.status, route, text);
  }
}
