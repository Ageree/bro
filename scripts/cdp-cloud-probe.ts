/**
 * The frame walk against a REAL Browser Use Cloud browser, not local
 * Chromium: `npm run cdp:probe:cloud`.
 *
 * `npm run cdp:probe` already proves the walk against a browser we launch
 * ourselves, which answers "is the code right" but not "does the vendor's
 * browser let us do this at all" — their Chrome could refuse
 * `Target.setAutoAttach`, or front CDP with something that drops the session
 * id a flattened attach depends on. So this one creates a standalone cloud
 * browser (`POST /browsers`, no agent run), builds a page holding an OTP
 * field in an embedded frame next to a genuinely cross-site frame, types a
 * code, and checks where it landed.
 *
 * It spends real money — a browser-minute, about $0.0003, and it always stops
 * the browser afterwards so nothing bills on to the 4-hour cap. It needs
 * `BROWSER_USE_API_KEY` and skips without one, which is why it is not named
 * `*:check` and stays out of `npm run check`.
 */
import { listCdpTargets, pickCdpPage } from "../convex/lib/browserCdp.ts";
import { cdpNavigate, cdpTypeIntoPage } from "../agent/lib/browser-cdp.ts";
import { normalizeBrowserUseKey } from "../agent/lib/browseruse.ts";

// `?? ""` rather than a narrowing guard: the key is read inside `bu()` below,
// and a control-flow check out here does not narrow a variable a function
// closes over.
const KEY = normalizeBrowserUseKey(
  process.env.BROWSER_USE_API_KEY ?? process.env.BROWSERUSE_API_KEY,
) ?? "";
if (!KEY) {
  console.log("cdp-cloud-probe skipped: no BROWSER_USE_API_KEY");
  process.exit(0);
}
const BASE =
  process.env.BROWSER_USE_BASE_URL?.trim().replace(/\/+$/, "") ||
  "https://api.browser-use.com/api/v4";
const CODE = "482913";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bu(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "X-Browser-Use-API-Key": KEY,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// Minimal raw CDP, only to BUILD the page under test — the code under test
// does its own connecting.
async function evaluate(cdpUrl: string, expression: string): Promise<unknown> {
  const page = pickCdpPage(await listCdpTargets(cdpUrl));
  const ws = new WebSocket(page!.webSocketDebuggerUrl!);
  await new Promise((r, j) => {
    ws.addEventListener("open", () => r(null));
    ws.addEventListener("error", () => j(new Error("ws error")));
  });
  const done = new Promise<unknown>((resolve) => {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === 1) resolve(msg.result?.result?.value);
    });
  });
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: false },
    }),
  );
  const value = await done;
  ws.close();
  return value;
}

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};

const created = await bu("/browsers", {
  method: "POST",
  body: JSON.stringify({ proxyCountryCode: null, timeout: 5 }),
});
const id: string = created.id;
console.log("browser", id);
let cdpUrl: string | undefined = created.cdpUrl ?? created.cdp_url;

try {
  for (let i = 0; i < 30 && !cdpUrl; i++) {
    await sleep(1000);
    const list = await bu("/browsers");
    const mine = list.items?.find((b: any) => b.id === id);
    cdpUrl = mine?.cdpUrl ?? mine?.cdp_url;
  }
  if (!cdpUrl) throw new Error("no cdpUrl from the cloud browser");
  console.log("cdp ready");

  const landed = await cdpNavigate(cdpUrl, "https://example.com", 30_000);
  check(Boolean(landed?.includes("example.com")), `cdpNavigate works on their browser (${landed})`);

  // A same-origin frame holding the OTP field (the shape of an embedded login
  // widget) and a genuinely cross-site frame (its own renderer) beside it.
  const page = `
    document.open();
    document.write(\`
      <h1>Оплата</h1>
      <input name="search" placeholder="Поиск">
      <iframe width="500" height="300" srcdoc='
        <input autocomplete="one-time-code" name="otp">
        <button type="button">Подтвердить</button>
        <script>
          document.addEventListener("input", function (e) { parent.__got = e.target.value; }, true);
          document.addEventListener("click", function () { parent.__clicked = true; }, true);
        <\\/script>'></iframe>
      <iframe src="https://www.iana.org/" width="500" height="300"></iframe>\`);
    document.close();
    "written";
  `;
  console.log("page:", await evaluate(cdpUrl, page));
  await sleep(4000);

  const result = await cdpTypeIntoPage(cdpUrl, CODE);
  console.log("result", JSON.stringify(result));
  await sleep(500);
  const got = await evaluate(cdpUrl, "String(window.__got ?? '')");
  const clicked = await evaluate(cdpUrl, "Boolean(window.__clicked)");

  check(result.typed === true, "cloud: the code was typed");
  check(result.inFrame === true, "cloud: it landed in an embedded frame, not the top document");
  check(got === CODE, `cloud: the OTP field holds the whole code (${JSON.stringify(got)})`);
  check(clicked === true && result.submitted === true, "cloud: Подтвердить was clicked");
  check(
    (result.searched ?? 0) >= 3,
    `cloud: the cross-site frame was reachable too — ${result.searched} contexts searched`,
  );
} finally {
  await bu(`/browsers/${id}`, { method: "PATCH", body: JSON.stringify({ action: "stop" }) })
    .then(() => console.log("browser stopped"))
    .catch((e) => console.error("stop failed", e));
}

console.log(failures === 0 ? "\ncloud-probe ok" : `\ncloud-probe: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
