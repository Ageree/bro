const HOSTS = new Set(["connect.composio.dev", "dashboard.composio.dev"]);

export function isConnectDest(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && HOSTS.has(u.hostname) && u.pathname.startsWith("/link/");
  } catch {
    return false;
  }
}

export function publicOrigin(): string {
  const raw = process.env.BRO_PUBLIC_URL?.trim();
  if (raw) return raw.replace(/\/$/, "");
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (host) return host.startsWith("http") ? host.replace(/\/$/, "") : `https://${host}`;
  return "https://bro-agent.vercel.app";
}

export function wrapConnectUrl(dest: string): string {
  return `${publicOrigin()}/l?to=${encodeURIComponent(dest)}`;
}

export function stripConnectUrls(text: string): string {
  return text
    .replace(/\[[^\]]*\]\(https:\/\/(?:connect|dashboard)\.composio\.dev\/[^)]+\)/g, "")
    .replace(/https:\/\/(?:connect|dashboard)\.composio\.dev\/\S+/g, "")
    .replace(/https:\/\/bro-agent\.vercel\.app\/l\?\S+/g, "")
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
