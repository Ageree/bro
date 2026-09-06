// Composio sandbox tools (COMPOSIO_REMOTE_WORKBENCH / COMPOSIO_REMOTE_BASH_TOOL)
// exist only to post-process large Composio tool responses. They must never
// become a backdoor way to fetch websites — that's what browser_task is for.

export const SANDBOX_NETWORK_RULE =
  "Сеть из sandbox запрещена: сайты открывай через browser_task";

// Composio's own API host — real post-processing code legitimately talks to it.
const ALLOWED_HOST_RE = /\b(?:[a-z0-9-]+\.)*composio\.dev\b/i;

// http(s):// URLs, captured so we can check the host against the allowlist.
const URL_RE = /https?:\/\/([a-z0-9.-]+)/gi;

// Python HTTP/network client libraries.
const PY_NET_RE =
  /\b(?:import|from)\s+(?:requests|urllib(?:\.[a-z]+)?|httpx|aiohttp|http\.client|socket|playwright|selenium)\b/i;

// Shell network utilities.
const SHELL_NET_RE = /\b(?:curl|wget|nc|ncat|netcat|ping)\b/i;

// JS/TS fetch calls.
const JS_FETCH_RE = /\bfetch\s*\(/i;

export function sandboxNetworkViolation(code: string): string | null {
  if (typeof code !== "string" || code.length === 0) return null;

  for (const match of code.matchAll(URL_RE)) {
    const host = match[1] ?? "";
    if (!ALLOWED_HOST_RE.test(host)) return SANDBOX_NETWORK_RULE;
  }

  if (PY_NET_RE.test(code)) return SANDBOX_NETWORK_RULE;
  if (SHELL_NET_RE.test(code)) return SANDBOX_NETWORK_RULE;
  if (JS_FETCH_RE.test(code)) return SANDBOX_NETWORK_RULE;

  return null;
}
