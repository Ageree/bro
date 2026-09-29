import { createHash } from "node:crypto";
import { env } from "@shared/environment";

/**
 * The sticky-session token of a workspace at the residential proxy. The same
 * workspace keeps the same exit across its errands and VM restarts, as a
 * person at home keeps their address, and no two workspaces share one: a site
 * would otherwise tie their sign-ins together. A rotation asks for another
 * exit when the one given is outside Russia (`prepareBrowserVmSession` in
 * `agent/lib/browser-vm/lifecycle.ts`).
 * Only letters and digits, which every provider's username syntax accepts.
 */
export function browserVmProxySession(workspaceId: string, rotation = 0) {
  const digest = createHash("sha256")
    .update(workspaceId)
    .digest("hex")
    .slice(0, 12);
  return rotation > 0 ? `bro${digest}r${String(rotation)}` : `bro${digest}`;
}

/**
 * The residential proxy the VM's Chrome goes out through, for one sticky
 * session. It is handed to the worker with `POST /v1/session` and kept only
 * in its memory, so the login never lands on the VM's disk.
 */
export function browserVmProxy(session: string) {
  const proxy = env.BROWSER_VM_PROXY;
  if (proxy === undefined) {
    throw new Error("BROWSER_VM_PROXY is not configured.");
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
