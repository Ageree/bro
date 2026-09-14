/**
 * Read the Cloud browser's real tab URL via CDP HTTP `/json`.
 * No WebSocket — safe in Convex actions. Navigation stays in eve.
 */

export type CdpTarget = {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
};

export type CloudBrowser = {
  id?: string;
  liveUrl?: string;
  cdpUrl?: string;
};

export function cdpHttpBase(cdpUrl: string): string {
  return cdpUrl
    .trim()
    .replace(/\/$/, "")
    .replace(/^ws:/i, "http:")
    .replace(/^wss:/i, "https:");
}

export function asCdpTargets(raw: unknown): CdpTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: CdpTarget[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const target: CdpTarget = {};
    if (typeof rec.id === "string") target.id = rec.id;
    if (typeof rec.type === "string") target.type = rec.type;
    if (typeof rec.url === "string") target.url = rec.url;
    if (typeof rec.title === "string") target.title = rec.title;
    if (typeof rec.webSocketDebuggerUrl === "string") {
      target.webSocketDebuggerUrl = rec.webSocketDebuggerUrl;
    }
    out.push(target);
  }
  return out;
}

export function pickCdpPage(targets: readonly CdpTarget[]): CdpTarget | undefined {
  return targets.find((t) => t.type === "page") ?? targets[0];
}

export function cdpCurrentUrl(targets: readonly CdpTarget[]): string | undefined {
  const url = pickCdpPage(targets)?.url?.trim();
  return url || undefined;
}

export async function listCdpTargets(cdpUrl: string): Promise<CdpTarget[]> {
  const res = await fetch(`${cdpHttpBase(cdpUrl)}/json`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`cdp json ${res.status}`);
  return asCdpTargets(await res.json());
}

export async function cdpPageUrl(cdpUrl: string): Promise<string | undefined> {
  return cdpCurrentUrl(await listCdpTargets(cdpUrl));
}

export function browserFromList(
  raw: unknown,
  sessionId: string,
): CloudBrowser | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const agent =
      (typeof rec.agentSessionId === "string" && rec.agentSessionId) ||
      (typeof rec.agent_session_id === "string" && rec.agent_session_id) ||
      "";
    if (agent !== sessionId) continue;
    return {
      ...(typeof rec.id === "string" ? { id: rec.id } : {}),
      ...(typeof rec.liveUrl === "string"
        ? { liveUrl: rec.liveUrl }
        : typeof rec.live_url === "string"
          ? { liveUrl: rec.live_url }
          : {}),
      ...(typeof rec.cdpUrl === "string"
        ? { cdpUrl: rec.cdpUrl }
        : typeof rec.cdp_url === "string"
          ? { cdpUrl: rec.cdp_url }
          : {}),
    };
  }
  return undefined;
}
