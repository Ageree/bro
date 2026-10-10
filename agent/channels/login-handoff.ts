import { defineChannel, GET, POST } from "eve/channels";
import { cancelBrowserVmWorkerHandoff } from "@agent/lib/browser-vm/worker";
import {
  newDeviceSecret,
  type OpenedHandoff,
  openLoginHandoff,
  ownsLoginHandoff,
} from "@agent/lib/login-handoff/open";
import {
  saveProfileSoon,
  settleLoginHandoff,
} from "@agent/lib/login-handoff/settle";
import { loginHandoffOn } from "@agent/lib/login-handoff/pilot";
import { readBrowserVm } from "@db/services/browser-vms";
import { endLoginHandoff, readLoginHandoff } from "@db/services/login-handoffs";
import { applicationOrigin } from "@shared/environment/origin";

/**
 * The doors of the sign-in window (`/handoff/<id>`, docs/login-handoff.md).
 * The link's id is the secret; the device that opens it first keeps a second
 * secret in a cookie scoped to this one link, and only that device can open
 * the viewer again, finish or cancel. A page read changes nothing, so a chat
 * app that previews the link does not take it.
 */
export const loginHandoffPath = "/eve/v1/login-handoff";

const noStore = { "cache-control": "private, no-store" } as const;
const cookieName = "bro_handoff";

/** What the page's calls are answered with. */
interface Answer {
  readonly domain?: string;
  readonly expired?: boolean;
  readonly mine?: boolean;
  readonly signedIn?: boolean | null;
  readonly state?: string;
}

function json(
  body: Answer | OpenedHandoff,
  status = 200,
  headers: Readonly<Record<string, string>> = {}
) {
  return Response.json(body, { headers: { ...noStore, ...headers }, status });
}

function deviceSecret(request: Request) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookieName) return value.join("=");
  }
  return undefined;
}

function secureCookie(id: string, secret: string) {
  const secure = applicationOrigin().startsWith("https:") ? "; Secure" : "";
  return `${cookieName}=${secret}; Path=${loginHandoffPath}/${id}; HttpOnly; SameSite=Strict; Max-Age=3600${secure}`;
}

/** A write comes from the page itself: its Origin is the application's. */
function fromOurPage(request: Request) {
  return request.headers.get("origin") === applicationOrigin();
}

/** A link's id as `newLinkId` makes it; anything else is no link, and goes nowhere near a cookie or a query. */
function linkIdOf(id: string | undefined) {
  return id !== undefined && /^[\w-]{16,64}$/u.test(id) ? id : undefined;
}

function enabled() {
  return loginHandoffOn();
}

export default defineChannel({
  audience() {
    return "unknown";
  },
  receive() {
    throw new Error("The sign-in window channel only serves its routes.");
  },
  routes: [
    // What the page shows before anything is taken: the site, and whether
    // the link still opens. Nothing else, and nothing changes.
    GET(`${loginHandoffPath}/:id`, async (request, { params }) => {
      if (!enabled()) return json({ state: "missing" }, 404);
      const id = linkIdOf(params.id);
      const row = id === undefined ? undefined : await readLoginHandoff(id);
      if (row === undefined) return json({ state: "missing" }, 404);
      const mine =
        row.deviceHash !== null &&
        deviceSecret(request) !== undefined &&
        (await ownsLoginHandoff(row.id, deviceSecret(request) ?? ""));
      return json({
        domain: row.domain,
        expired: row.state === "pending" && row.expiresAt < new Date(),
        mine,
        state: row.state,
      });
    }),
    // The person presses «Начать» (and again after a reload or a lost
    // connection): the first device takes the link, and the answer says how
    // near the viewer is.
    POST(`${loginHandoffPath}/:id/open`, async (request, { params }) => {
      const id = linkIdOf(params.id);
      if (id === undefined || !enabled() || !fromOurPage(request)) {
        return json({}, 404);
      }
      const existing = deviceSecret(request);
      const secret = existing ?? newDeviceSecret();
      const opened = await openLoginHandoff({ deviceSecret: secret, id });
      return json(
        opened,
        200,
        existing === undefined ? { "set-cookie": secureCookie(id, secret) } : {}
      );
    }),
    // «Готово»: the worker has the page's last look; read it and end.
    POST(`${loginHandoffPath}/:id/finish`, async (request, { params }) => {
      const id = linkIdOf(params.id);
      const secret = deviceSecret(request);
      if (
        id === undefined ||
        !enabled() ||
        !fromOurPage(request) ||
        secret === undefined ||
        !(await ownsLoginHandoff(id, secret))
      ) {
        return json({}, 404);
      }
      const row = await readLoginHandoff(id);
      if (row === undefined) return json({}, 404);
      if (row.state === "claimed") await settleLoginHandoff(row);
      const after = await readLoginHandoff(id);
      return json({ signedIn: after?.signedIn ?? null, state: after?.state });
    }),
    POST(`${loginHandoffPath}/:id/cancel`, async (request, { params }) => {
      const id = linkIdOf(params.id);
      const secret = deviceSecret(request);
      if (
        id === undefined ||
        !enabled() ||
        !fromOurPage(request) ||
        secret === undefined ||
        !(await ownsLoginHandoff(id, secret))
      ) {
        return json({}, 404);
      }
      const row = await readLoginHandoff(id);
      if (row?.state !== "claimed" || row.workerId === null) {
        return json({ state: row?.state });
      }
      const now = new Date();
      const vm = await readBrowserVm(row.workspaceId);
      // The worker says how it ended. One that cannot be asked leaves the
      // handoff as it was (it ends on its own window), unless the worker
      // never took it in; one that had already finished is settled, not
      // overwritten.
      if (vm?.host != null && row.workerOpenedAt !== null) {
        let handed: Awaited<ReturnType<typeof cancelBrowserVmWorkerHandoff>>;
        try {
          handed = await cancelBrowserVmWorkerHandoff(vm, row.workerId);
        } catch {
          return json({ state: "claimed" });
        }
        if (handed?.state === "done") {
          await settleLoginHandoff(row, now);
          return json({ state: (await readLoginHandoff(id))?.state });
        }
      } else if (row.workerOpenedAt !== null) {
        return json({ state: "claimed" });
      }
      await endLoginHandoff(id, { report: null, state: "cancelled" }, now);
      await saveProfileSoon(row.workspaceId, now);
      return json({ state: "cancelled" });
    }),
  ],
});
