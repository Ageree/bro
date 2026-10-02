import { createHmac } from "node:crypto";
import { z } from "zod";
import { browserVmKey } from "@agent/lib/browser-vm/token";
import type { browserHosts } from "@db/schema/browser-hosts";
import { env } from "@shared/environment";
import { browserHostKey, browserSandboxId, browserStateDataKey } from "./keys";
import { presignStoredObject } from "@shared/object-storage/s3";
import { readBrowserStateObject } from "./s3";

/**
 * The HTTP client of `hostd` on a host of the browser pool
 * (`browser-vm/host/hostd.py`, the source of truth for every shape here),
 * reached through the host's Caddy at `/h/`. Sandboxes' workers answer on
 * the same address under `/g/<sandbox id>/`, with their own tokens
 * (`agent/lib/browser-vm/worker.ts`). Every call but the health check
 * carries a fresh host token.
 */

/**
 * The columns of a `browser_hosts` row a call needs: where the host answers
 * and whose key signs its tokens.
 */
type BrowserHostTarget = Readonly<
  Pick<typeof browserHosts.$inferSelect, "address" | "id">
>;

/** `reserve_mb` of `hostd`: memory its sandboxes' limits leave to the host. */
export const browserHostReserveMb = 1_024;

/** `hostd` refuses a token that lives longer. */
const maximumTokenSeconds = 900;
const healthTimeoutMs = 5_000;
const readTimeoutMs = 15_000;
// A start downloads and unpacks a set (seconds), restores or boots Chrome
// and waits up to 90 s for the worker; a park stops Chrome (or, under runsc,
// freezes the sandbox), packs and uploads up to gigabytes. Cut off sooner, a
// call that succeeded would read as failed.
const startTimeoutMs = 240_000;
const parkTimeoutMs = 300_000;
/** `chunk_bytes` of `hostd`: the size a set is cut into. */
const chunkBytes = 16 * 1024 * 1024;
/** Room for the profile archive (next to the image under runsc) in a set. */
const profileBudgetMb = 2_048;
/** `hostd` takes at most this many chunk URLs. */
const maximumChunks = 4_096;
/** Presigned URLs outlive the call they go with, with room for its retries. */
const parkUrlSeconds = 60 * 60;
const restoreUrlSeconds = 30 * 60;

/**
 * `runc` or `runsc`, and that runtime's version. Absent from a `hostd`
 * older than the runtime setting, which ran runsc only.
 */
const runtimeFields = {
  runtime: z.string().nullish(),
  runtimeVersion: z.string().nullish(),
};

const healthSchema = z.object({
  configured: z.boolean(),
  hostd: z.string(),
  ...runtimeFields,
  runsc: z.string().nullable(),
  /** The boot stage of `provision.sh`: `ready`, or `failed:<stage>:line N`. */
  stage: z.string().nullable(),
});

const sizeSchema = z.object({ freeMb: z.number(), totalMb: z.number() });

const capacitySchema = z.object({
  cpu: z.object({ features: z.string(), model: z.string() }),
  disk: sizeSchema.nullable(),
  host: z.string().nullable(),
  memoryMb: z
    .object({
      available: z.number(),
      committed: z.number(),
      total: z.number(),
    })
    .nullable(),
  rootfsVersions: z.array(z.string()),
  ...runtimeFields,
  runsc: z.string().nullable(),
  sandboxes: z.array(
    z.object({
      generation: z.number().int(),
      id: z.string(),
      memoryMb: z.number(),
      state: z.string(),
      usedMb: z.number().nullable(),
    })
  ),
  shm: sizeSchema.nullable(),
});

const parkSchema = z.object({
  chunks: z.number().int().positive(),
  /**
   * What a restore of the snapshot must match: runsc, CPU features, rootfs,
   * memory. Null under runc, whose set is the profile alone.
   */
  format: z.record(z.string(), z.json()).nullable(),
  generation: z.number().int(),
  id: z.string(),
  parts: z.record(
    z.string(),
    z.object({
      bytes: z.number(),
      chunks: z.number().int(),
      plainBytes: z.number(),
    })
  ),
  runtime: z.string().nullish(),
  state: z.literal("parked"),
  timings: z.record(z.string(), z.json()),
});

/** What Bro reads of a set's manifest (`sets.upload` in `sets.py`). */
const manifestSchema = z.object({
  generation: z.number().int(),
  parts: z.array(z.object({ chunks: z.array(z.unknown()) })),
  snapshot: z.record(z.string(), z.json()).nullable(),
  workspace: z.string(),
});

const sandboxSchema = z.object({
  error: z.string().nullish(),
  /** Why a restore fell back to a cold start. */
  fallback: z.string().nullish(),
  generation: z.number().int(),
  id: z.string(),
  memoryMb: z.number().int(),
  /** `fresh`, `restored`, `cold` or `adopted`; null while it comes up. */
  path: z.string().nullable(),
  rootfsVersion: z.string(),
  state: z.enum([
    "starting",
    "restoring",
    "running",
    "parking",
    "parked",
    "failed",
  ]),
  workspace: z.string(),
  /**
   * What the last park of this sandbox answered, while its record stays on
   * the host: how a park whose answer was lost is read back.
   */
  parked: parkSchema.nullish(),
});

/** A `hostd` reply that was not a 2xx, with its JSON error when it had one. */
export class BrowserHostError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, path: string, body: string) {
    super(`Browser host ${String(status)} on ${path}: ${body.slice(0, 300)}`);
    this.name = "BrowserHostError";
    this.status = status;
    this.body = body;
  }
}

/**
 * A short-lived bearer token for one host's `hostd`, checked by
 * `verify_token` in `browser-vm/host/hostd.py`: the worker's format with the
 * host's key and no generation (fencing is per sandbox, in the request
 * bodies). The payload's keys and their order are part of the signed bytes.
 */
export function signBrowserHostToken(hostId: string, ttlSeconds = 300) {
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > maximumTokenSeconds
  ) {
    throw new Error(
      `A browser host token lives 1 to ${String(maximumTokenSeconds)} seconds.`
    );
  }
  const exp = Math.floor(Date.now() / 1_000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ env: hostId, exp })).toString(
    "base64url"
  );
  const signed = `v1.${payload}`;
  const signature = createHmac("sha256", browserHostKey(hostId))
    .update(signed)
    .digest("base64url");
  return `${signed}.${signature}`;
}

/**
 * The host's HTTPS origin: Caddy on it holds a certificate for the
 * address's sslip.io name, as a per-workspace VM does.
 */
export function browserHostOrigin(host: BrowserHostTarget) {
  const { address } = host;
  if (address === null || !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(address)) {
    throw new Error("The browser host has no public IPv4 address yet.");
  }
  return `https://${address.replaceAll(".", "-")}.sslip.io`;
}

/**
 * Where a workspace's worker answers while its sandbox lives on the host:
 * Caddy strips `/g/<sandbox id>` and passes the rest to the worker, whose
 * API and tokens are the VM's.
 */
export function browserSandboxWorkerOrigin(
  host: BrowserHostTarget,
  workspaceId: string
) {
  return `${browserHostOrigin(host)}/g/${browserSandboxId(workspaceId)}`;
}

/**
 * The key prefix of the set a sandbox parks at `generation`
 * (`sets/<sandbox id>/<generation>/`): `chunk-0000`… and `manifest.json`
 * under it. A newer set never writes over an older one, which stays whole
 * until the newer manifest is in.
 */
export function browserStateSetKey(workspaceId: string, generation: number) {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("A set generation is a whole number.");
  }
  return `sets/${browserSandboxId(workspaceId)}/${String(generation)}/`;
}

/** Unsigned: whether `hostd` is up, and how far the host's boot got. */
export async function readBrowserHostHealth(host: BrowserHostTarget) {
  return healthSchema.parse(
    await request(host, "GET", "/v1/health", {
      signed: false,
      timeoutMs: healthTimeoutMs,
    })
  );
}

/** Memory, disk, the sandboxes held and the root file systems unpacked. */
export async function readBrowserHostCapacity(host: BrowserHostTarget) {
  return capacitySchema.parse(
    await request(host, "GET", "/v1/capacity", { timeoutMs: readTimeoutMs })
  );
}

/**
 * Start the workspace's sandbox on the host at `generation`: fresh with an
 * empty profile, or from the set at `from.key` (`from.chunks` as the park
 * reported), restoring its snapshot when `from.snapshot` and the host can,
 * else cold with its profile alone. The set must be strictly older than
 * `generation`. The same id and generation again answers about the live
 * sandbox, so a start whose answer was lost can be sent again.
 */
export async function startBrowserSandbox(
  host: BrowserHostTarget,
  input: {
    readonly from?: {
      readonly chunks: number;
      readonly key: string;
      readonly snapshot: boolean;
    };
    readonly generation: number;
    readonly workspaceId: string;
  }
) {
  const rootfs = env.BROWSER_SANDBOX_ROOTFS;
  if (rootfs === undefined) {
    throw new Error("BROWSER_SANDBOX_ROOTFS is not configured.");
  }
  const { from, workspaceId } = input;
  const fresh = {
    generation: input.generation,
    id: browserSandboxId(workspaceId),
    memoryMb: env.BROWSER_SANDBOX_MEMORY_MB,
    rootfsVersion: rootfs.version,
    workerKey: browserVmKey(workspaceId).toString("hex"),
    workspace: workspaceId,
  };
  // A snapshot goes as `restore`, falling back to a cold start by itself; a
  // set whose snapshot is known not to fit goes as `profile`.
  const body =
    from === undefined
      ? fresh
      : {
          ...fresh,
          [from.snapshot ? "restore" : "profile"]: {
            chunkUrls: setUrls(from.key, from.chunks, "GET", restoreUrlSeconds),
            dataKey: browserStateDataKey(workspaceId),
            manifestUrl: manifestUrl(from.key, "GET", restoreUrlSeconds),
          },
        };
  return sandboxSchema.parse(
    await request(host, "POST", "/v1/sandboxes", {
      body,
      timeoutMs: startTimeoutMs,
    })
  );
}

/** The workspace's sandbox on the host, or undefined when it has none. */
export async function readBrowserSandbox(
  host: BrowserHostTarget,
  workspaceId: string
) {
  try {
    return sandboxSchema.parse(
      await request(
        host,
        "GET",
        `/v1/sandboxes/${browserSandboxId(workspaceId)}`,
        { timeoutMs: readTimeoutMs }
      )
    );
  } catch (error) {
    if (error instanceof BrowserHostError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Pack the workspace's sandbox into a new set at `generation` (the
 * sandbox's own or newer) and take it off the host: under runc Chrome stops
 * and the profile alone is the set; under runsc the sandbox is frozen with
 * it. The worker must have dropped its secrets first (`POST /v1/park` of the
 * worker), and no run may be going. The answer carries the set's key
 * prefix, chunk count and snapshot format (null without a snapshot), which
 * a restore needs; a park retried after it succeeded answers the same.
 */
export async function parkBrowserSandbox(
  host: BrowserHostTarget &
    Readonly<Partial<Pick<typeof browserHosts.$inferSelect, "capacity">>>,
  input: {
    /**
     * A park that failed before: every chunk URL `hostd` takes goes with it,
     * in case the set outgrew the usual budget.
     */
    readonly ample?: boolean;
    readonly generation: number;
    readonly workspaceId: string;
  }
) {
  const key = browserStateSetKey(input.workspaceId, input.generation);
  const parked = parkSchema.parse(
    await request(
      host,
      "POST",
      `/v1/sandboxes/${browserSandboxId(input.workspaceId)}/park`,
      {
        body: {
          dataKey: browserStateDataKey(input.workspaceId),
          generation: input.generation,
          upload: {
            chunkUrls: setUrls(
              key,
              input.ample === true
                ? maximumChunks
                : parkChunks(host.capacity?.runtime),
              "PUT",
              parkUrlSeconds
            ),
            manifestUrl: manifestUrl(key, "PUT", parkUrlSeconds),
          },
        },
        timeoutMs: parkTimeoutMs,
      }
    )
  );
  return { ...parked, key };
}

/**
 * The set a park wrote at `generation`, read from its manifest in Object
 * Storage (`sets.upload` of `browser-vm/host/sets.py`): how a park whose
 * set is in but whose sandbox `hostd` could not delete (`setWritten`) is
 * recorded all the same. Undefined when there is no whole set of the
 * workspace there. The manifest's MAC is `hostd`'s to check on restore.
 */
export async function readWrittenBrowserSet(
  workspaceId: string,
  generation: number
) {
  const key = browserStateSetKey(workspaceId, generation);
  const text = await readBrowserStateObject(`${key}manifest.json`);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const manifest = manifestSchema.safeParse(json).data;
  if (
    manifest === undefined ||
    manifest.workspace !== workspaceId ||
    manifest.generation !== generation
  ) {
    return undefined;
  }
  const chunks = manifest.parts.reduce(
    (total, part) => total + part.chunks.length,
    0
  );
  if (chunks < 1) return undefined;
  return { chunks, format: manifest.snapshot, generation };
}

/**
 * Stop the workspace's sandbox and wipe it from the host. False when the
 * host had none; a stale generation is refused (409).
 */
export async function deleteBrowserSandbox(
  host: BrowserHostTarget,
  input: { readonly generation: number; readonly workspaceId: string }
) {
  return deleteBrowserHostSandbox(host, {
    generation: input.generation,
    id: browserSandboxId(input.workspaceId),
  });
}

/**
 * The same by the sandbox's own id, as `GET /v1/capacity` lists it: how a
 * sandbox the host holds for nobody Bro knows of is cleared away.
 */
export async function deleteBrowserHostSandbox(
  host: BrowserHostTarget,
  input: { readonly generation: number; readonly id: string }
) {
  if (!/^[a-z\d-]{1,63}$/u.test(input.id)) {
    throw new Error("A sandbox id matches [a-z0-9-]{1,63}.");
  }
  try {
    await request(
      host,
      "DELETE",
      `/v1/sandboxes/${input.id}?generation=${String(input.generation)}`,
      { timeoutMs: readTimeoutMs }
    );
    return true;
  } catch (error) {
    if (error instanceof BrowserHostError && error.status === 404) return false;
    throw error;
  }
}

/**
 * Chunk URLs a park takes: a set holds the sandbox's profile and, under
 * runsc, its memory image, compressed, so their plain size (with a margin
 * for data zstd cannot shrink) bounds it. `hostd` says how many it used.
 * The runtime is the one the host reports, not BROWSER_HOST_RUNTIME: hosts
 * made before that setting changed run on as they were made. A host that
 * reports none (a runsc-only `hostd`, or capacity not read yet) gets the
 * runsc budget, which holds a runc set too; one Bro does not know gets
 * every URL `hostd` takes.
 */
function parkChunks(runtime: string | null | undefined) {
  let imageMb = env.BROWSER_SANDBOX_MEMORY_MB;
  switch (runtime ?? "runsc") {
    case "runc": {
      imageMb = 0;
      break;
    }
    case "runsc": {
      break;
    }
    default: {
      return maximumChunks;
    }
  }
  const megabytes = (imageMb + profileBudgetMb) * 1.02;
  const chunks = Math.ceil((megabytes * 1024 * 1024) / chunkBytes) + 2;
  return Math.min(chunks, maximumChunks);
}

function setUrls(
  key: string,
  count: number,
  method: "GET" | "PUT",
  expiresSeconds: number
) {
  if (!Number.isInteger(count) || count < 1 || count > maximumChunks) {
    throw new Error("A set has 1 to 4096 chunks.");
  }
  const now = new Date();
  return Array.from({ length: count }, (_, index) =>
    presignStoredObject({
      expiresSeconds,
      key: `${key}chunk-${String(index).padStart(4, "0")}`,
      method,
      now,
    })
  );
}

function manifestUrl(
  key: string,
  method: "GET" | "PUT",
  expiresSeconds: number
) {
  return presignStoredObject({
    expiresSeconds,
    key: `${key}manifest.json`,
    method,
  });
}

async function request(
  host: BrowserHostTarget,
  method: "DELETE" | "GET" | "POST",
  path: string,
  options: {
    readonly body?: unknown;
    readonly signed?: boolean;
    readonly timeoutMs: number;
  }
) {
  const headers = new Headers({ accept: "application/json" });
  if (options.signed !== false) {
    headers.set("authorization", `Bearer ${signBrowserHostToken(host.id)}`);
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
  // No retry here: a start or a park is the caller's to repeat, by its
  // generation.
  const response = await fetch(`${browserHostOrigin(host)}/h${path}`, init);
  const route = path.split("?")[0] ?? path;
  const text = await response.text();
  if (!response.ok) throw new BrowserHostError(response.status, route, text);
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    throw new BrowserHostError(response.status, route, text);
  }
}
