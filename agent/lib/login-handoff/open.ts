import { createHash, randomBytes } from "node:crypto";
import { keepBrowserVmForErrand } from "@agent/lib/browser-vm/idle";
import {
  ensureBrowserVm,
  prepareBrowserVmSession,
} from "@agent/lib/browser-vm/lifecycle";
import {
  browserVmHandoffViewer,
  BrowserVmWorkerError,
  openBrowserVmWorkerHandoff,
} from "@agent/lib/browser-vm/worker";
import { usesBrowserVm } from "@agent/lib/browser-vm/backend";
import {
  claimLoginHandoff,
  readLoginHandoff,
} from "@db/services/login-handoffs";
import { applicationOrigin } from "@shared/environment/origin";

/** How long a link opens, and how long the viewer lasts once it is opened. */
export const linkLifetimeMs = 30 * 60_000;
const viewerLifetimeMs = 15 * 60_000;

/** The secret that marks a device: its hash is all the database keeps. */
export function deviceHash(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

/** A new link's secret: the link is the only place it is written. */
export function newLinkId() {
  return randomBytes(24).toString("base64url");
}

export function newDeviceSecret() {
  return randomBytes(24).toString("base64url");
}

function newWorkerHandoffId() {
  return `h_${randomBytes(18).toString("base64url")}`;
}

/** The address of the page that shows the viewer. */
export function loginHandoffLink(id: string) {
  return new URL(`/handoff/${id}`, applicationOrigin()).toString();
}

export type OpenedHandoff =
  | { readonly kind: "busy" }
  | { readonly kind: "failed" }
  | {
      readonly kind: "gone";
      readonly reason: "ended" | "expired" | "missing" | "taken";
    }
  | {
      readonly domain: string;
      readonly expiresAt: string;
      readonly kind: "ready";
      readonly viewer: { readonly token: string; readonly url: string };
    }
  | { readonly kind: "starting"; readonly retryAfterMs: number }
  | { readonly kind: "unsupported" };

/**
 * The person opens the link from a device: the first device to do so owns it
 * (the secret it keeps in a cookie), and from then on every call of that
 * device brings the viewer closer — the browser starting is waited for by
 * asking again — until it is ready, with the socket and the token to open it
 * with. A page reloaded or a connection lost asks again and gets a fresh
 * token for the same worker handoff.
 */
export async function openLoginHandoff(
  input: { readonly deviceSecret: string; readonly id: string },
  now = new Date()
): Promise<OpenedHandoff> {
  const claim = await claimLoginHandoff(
    {
      deviceHash: deviceHash(input.deviceSecret),
      id: input.id,
      viewMs: viewerLifetimeMs,
      workerId: newWorkerHandoffId(),
    },
    now
  );
  if (claim.kind !== "claimed" && claim.kind !== "again") {
    return { kind: "gone", reason: claim.kind };
  }
  const { row } = claim;
  const { workspaceId } = row;
  if (
    row.workerId === null ||
    row.viewUntil === null ||
    !(await usesBrowserVm({ userId: row.createdByUserId, workspaceId }))
  ) {
    return { kind: "unsupported" };
  }
  const started = await ensureBrowserVm(workspaceId, now);
  if (started.kind === "starting") {
    return { kind: "starting", retryAfterMs: started.retryAfterMs };
  }
  // The same sticky exit as every errand of the person: a site that ties a
  // session to the address must see it again later.
  const vm = await prepareBrowserVmSession(started.vm, now, {
    rotate: false,
  });
  const ttlSeconds = Math.min(
    1_800,
    Math.max(60, Math.floor((row.viewUntil.getTime() - now.getTime()) / 1_000))
  );
  try {
    await openBrowserVmWorkerHandoff(vm, {
      domains: row.allowedDomains,
      id: row.workerId,
      origin: applicationOrigin(),
      ttlSeconds,
      url: row.siteUrl,
    });
  } catch (error) {
    if (error instanceof BrowserVmWorkerError) {
      // 409: an errand holds the browser, or another handoff is open.
      if (error.status === 409) return { kind: "busy" };
      // An older worker has no such route.
      if (error.status === 404 || error.status === 405) {
        return { kind: "unsupported" };
      }
    }
    console.warn("[login-handoff] the worker did not open the handoff", {
      cause: error,
      workspaceId,
    });
    return { kind: "failed" };
  }
  await keepBrowserVmForErrand(workspaceId, true, now);
  return {
    domain: row.domain,
    expiresAt: row.viewUntil.toISOString(),
    kind: "ready",
    viewer: browserVmHandoffViewer(vm, row.workerId),
  };
}

/** Who may finish a handoff: the device that opened it. */
export async function ownsLoginHandoff(id: string, deviceSecret: string) {
  const row = await readLoginHandoff(id);
  return (
    row !== undefined &&
    row.deviceHash !== null &&
    row.deviceHash === deviceHash(deviceSecret)
  );
}
