import { createHash } from "node:crypto";
import { env } from "@shared/environment";
import { proxyFallbackFirstPilot } from "./pilot";

/**
 * A residential proxy by the setting that holds its line: BROWSER_VM_PROXY,
 * or BROWSER_VM_PROXY_FALLBACK, a second provider.
 */
export type BrowserVmProxyLine =
  | "BROWSER_VM_PROXY"
  | "BROWSER_VM_PROXY_FALLBACK";

/**
 * The proxies a workspace's browser goes out through, in the order it tries
 * them. It starts on the first, moves to the second only when every rotation
 * there gave no usable exit in Russia or the proxy refused Bro's login, and
 * stays where it moved, as a person keeps their address
 * (`routeThroughRussia` in `agent/lib/browser-vm/lifecycle.ts`). Without
 * BROWSER_VM_PROXY_FALLBACK there is one, and nothing is looked up; a
 * workspace in BROWSER_PROXY_FALLBACK_FIRST_WORKSPACES starts on the
 * fallback.
 */
export async function browserVmProxyLines(scope: {
  readonly workspaceId: string;
}): Promise<readonly [BrowserVmProxyLine, BrowserVmProxyLine?]> {
  if (env.BROWSER_VM_PROXY_FALLBACK === undefined) return ["BROWSER_VM_PROXY"];
  return (await proxyFallbackFirstPilot(scope))
    ? ["BROWSER_VM_PROXY_FALLBACK", "BROWSER_VM_PROXY"]
    : ["BROWSER_VM_PROXY", "BROWSER_VM_PROXY_FALLBACK"];
}

/**
 * The sticky-session token of a workspace at the residential proxy. The same
 * workspace keeps the same exit across its errands and VM restarts, as a
 * person at home keeps their address, and no two workspaces share one: a site
 * would otherwise tie their sign-ins together. A rotation asks for another
 * exit when the one given is outside Russia (`prepareBrowserVmSession` in
 * `agent/lib/browser-vm/lifecycle.ts`). A workspace that moved to the second
 * proxy of its order (`browserVmProxyLines`) has sessions of its own there,
 * marked `s`: the stored token says where it stands.
 * Only letters and digits, which every provider's username syntax accepts.
 */
export function browserVmProxySession(
  workspaceId: string,
  rotation = 0,
  moved = false
) {
  const digest = createHash("sha256")
    .update(workspaceId)
    .digest("hex")
    .slice(0, 12);
  if (moved) return `bro${digest}s${String(rotation)}`;
  return rotation > 0 ? `bro${digest}r${String(rotation)}` : `bro${digest}`;
}

/**
 * Where a stored sticky session stands: on which of the workspace's proxies
 * (`browserVmProxyLines`) and at which rotation. A session on the second
 * proxy of a deployment that no longer has one starts over on the first.
 */
export function browserVmProxyPlace(
  session: string | null,
  lines: Awaited<ReturnType<typeof browserVmProxyLines>>
) {
  const groups = /^bro[\da-f]{12}(?:(?<mark>[rs])(?<rotation>\d+))?$/u.exec(
    session ?? ""
  )?.groups;
  const [first, second] = lines;
  if (groups?.mark !== "s") {
    return { line: first, rotation: Number(groups?.rotation ?? 0) };
  }
  return second === undefined
    ? { line: first, rotation: 0 }
    : { line: second, rotation: Number(groups.rotation) };
}

/**
 * The residential proxy the VM's Chrome goes out through, for one sticky
 * session. It is handed to the worker with `POST /v1/session` and kept only
 * in its memory, so the login never lands on the VM's disk.
 */
export function browserVmProxy(
  session: string,
  line: BrowserVmProxyLine = "BROWSER_VM_PROXY"
) {
  const proxy = env[line];
  if (proxy === undefined) {
    throw new Error(`${line} is not configured.`);
  }
  if (!/^[A-Za-z0-9]+$/u.test(session)) {
    throw new Error("A proxy session token is letters and digits only.");
  }
  return {
    host: proxy.host,
    password: proxy.password,
    port: proxy.port,
    username: proxy.username.replaceAll("{session}", session),
  };
}
