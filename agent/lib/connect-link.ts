const HOSTS = new Set(["connect.composio.dev", "dashboard.composio.dev"]);

/** The one host that exists only to host Connect Links — every path on it is one. */
const CONNECT_ONLY_HOST = "connect.composio.dev";

/**
 * Is this a Connect Link we are willing to wrap and hand to a human?
 *
 * This mirrors Composio's own extractor (`@composio/experimental`,
 * `dist/auth-links-*.mjs`): anything on `connect.composio.dev` is a connect
 * link whatever its path, and the `/link/` marker is only demanded of the
 * OTHER composio hosts, where most paths are dashboard pages rather than an
 * authorization handoff. We used to demand `/link/` everywhere, which meant a
 * live link shaped like `https://connect.composio.dev/c/<id>` was silently
 * dropped by `sendConnectIfAny` — no card, no error — and `/l` answered it
 * with a 400. The https-only rule and the host allowlist stay: they are what
 * stops `/l` from being an open redirector.
 */
export function isConnectDest(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (!HOSTS.has(u.hostname)) return false;
    // A bare host is a landing page, not a handoff — it authorizes nothing.
    if (u.pathname === "/" || u.pathname === "") return false;
    if (u.hostname === CONNECT_ONLY_HOST) return true;
    return u.pathname.startsWith("/link/");
  } catch {
    return false;
  }
}

function asOrigin(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  return v.startsWith("http") ? v.replace(/\/+$/, "") : `https://${v.replace(/\/+$/, "")}`;
}

/**
 * The origin that actually serves `GET /l` — this agent's own deployment.
 *
 * It used to read `BRO_PUBLIC_URL` first, and that is the incident. In
 * production `BRO_PUBLIC_URL` is the BRAND domain (brobro.tech), which is a
 * different Vercel project: the landing site. `/l` is a route of the agent
 * (`agent/channels/imessage.ts`), so every Connect Link Bro ever sent pointed
 * at a host that has no such route and answered `404 NOT_FOUND` from Vercel.
 * The link was delivered, it was well-formed, it validated — and it went
 * nowhere. From the outside that is indistinguishable from "Composio is
 * broken", which is exactly how it was reported.
 *
 * So this resolver deliberately does NOT consult `BRO_PUBLIC_URL`: a pretty
 * domain is only usable here if it proxies `/l` to the agent, and nothing in
 * this repo can verify that. `BRO_LINK_ORIGIN` is the explicit override for
 * whoever sets that proxy up; otherwise we use the agent's own production URL,
 * which is the one host guaranteed to carry the route we are linking to.
 */
export function publicOrigin(): string {
  return (
    asOrigin(process.env.BRO_LINK_ORIGIN) ??
    asOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL) ??
    asOrigin(process.env.VERCEL_URL) ??
    "https://bro-agent.vercel.app"
  );
}

export function wrapConnectUrl(dest: string): string {
  return `${publicOrigin()}/l?to=${encodeURIComponent(dest)}`;
}

/**
 * Keep raw Composio URLs out of whatever the model wrote.
 *
 * The intent is narrow: a `connect.composio.dev` / `dashboard.composio.dev`
 * URL is a bearer credential for someone's account, so it must not end up
 * pasted into free-text prose where it can be quoted, forwarded or logged.
 * The sanctioned channel is the card `sendConnectIfAny` sends: our own `/l`
 * wrapper, built from a URL that already passed `isConnectDest`.
 *
 * This deliberately does NOT strip that wrapper. It used to — there was a
 * `https://bro-agent.vercel.app/l?\S+` rule here, aimed at the same host
 * `publicOrigin()` resolves to in production — so the card built one line
 * earlier was deleted one line later. On Telegram the human got a buttonless
 * «Подключи приложение»; on iMessage the whole message stripped to "" and
 * `toIMessageBubbles("")` sent nothing at all, with no error and no log.
 * Nothing is lost by keeping the wrapper: `/l` only ever redirects to a URL
 * that `isConnectDest` accepts, so it cannot be turned into a link to
 * anywhere else, and the model has no way to mint one — it only ever sees the
 * raw Composio URL, which the rules above still remove.
 */
export function stripConnectUrls(text: string): string {
  return text
    .replace(/\[[^\]]*\]\(https:\/\/(?:connect|dashboard)\.composio\.dev\/[^)]+\)/g, "")
    .replace(/https:\/\/(?:connect|dashboard)\.composio\.dev\/\S+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function connectCardHtml(dest: string): string {
  const href = esc(dest);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>View Link</title>
  <meta property="og:title" content="View Link" />
  <meta property="og:description" content="bro" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary" />
  <meta http-equiv="refresh" content="0;url=${href}" />
</head>
<body>
  <p><a href="${href}">Continue</a></p>
  <script>location.replace(${JSON.stringify(dest)})</script>
</body>
</html>`;
}
