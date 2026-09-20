/**
 * Real-browser proof for the frame walk in `agent/lib/browser-cdp.ts`:
 * `npm run cdp:probe`.
 *
 * It serves a page whose one-time-code field lives inside a cross-site iframe
 * — the shape a bank's 3-D Secure challenge actually has — next to an ad
 * frame, a 0x0 tracking frame whose input is named as temptingly as possible,
 * and a password field, then checks the code lands in the bank frame and
 * nowhere else. A cross-site frame only becomes a separate renderer (the case
 * that used to be invisible) under `--site-per-process`, which is why the
 * page is served on `localhost` and the frames on `127.0.0.1`: to Chrome
 * those are different sites.
 *
 * This one drives a real browser, so it is deliberately NOT named `*:check`
 * and stays out of `npm run check`, which is an offline, no-network battery.
 * `CHROME_PATH` points it at a binary; without one it skips rather than fails.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdpNavigate, cdpTypeIntoPage } from "../agent/lib/browser-cdp.ts";

const PORT = Number(process.env.CDP_PROBE_PORT ?? 8899);
const DEBUG_PORT = Number(process.env.CDP_PROBE_DEBUG_PORT ?? 9222);
const CDP = `http://127.0.0.1:${DEBUG_PORT}`;
const CHROME =
  process.env.CHROME_PATH?.trim() ||
  ["/opt/pw-browsers/chromium", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((p) =>
    existsSync(p),
  );
if (!CHROME) {
  console.log("cdp-frames-probe skipped: no Chromium found (set CHROME_PATH)");
  process.exit(0);
}
const CODE = "482913";
const collected: { who: string; kind: string; value: string }[] = [];

const html = (body: string) =>
  `<!doctype html><meta charset="utf-8"><body style="margin:0">${body}</body>`;

// Every field reports what it received, so the assertions never depend on
// reading state back through the same CDP path under test.
const report = `
  const send = (kind, el) => fetch("http://127.0.0.1:${PORT}/collect?who=" + WHO + "&kind=" + kind + "&value=" + encodeURIComponent(el ? (el.value || "") : ""), { mode: "no-cors" });
  document.addEventListener("input", (e) => send("input", e.target), true);
  document.addEventListener("click", (e) => { if (e.target.closest("button")) send("click", null); }, true);
`;

const frames: Record<string, string> = {
  "3ds": html(
    `<form><input autocomplete="one-time-code" name="otp" placeholder="Код из СМС"><button type="button">Подтвердить</button></form>
     <script>const WHO="3ds";${report}</script>`,
  ),
  "3ds-plain": html(
    `<form><input name="code"><button type="button">Подтвердить</button></form>
     <script>const WHO="3ds-plain";${report}</script>`,
  ),
  "3ds-pay": html(
    `<form><input autocomplete="one-time-code" name="otp"><button type="button">Оплатить</button></form>
     <script>const WHO="3ds-pay";${report}</script>`,
  ),
  boxes: html(
    `<form>${Array.from({ length: 6 }, () => `<input maxlength="1" inputmode="numeric">`).join("")}<button type="button">Подтвердить</button></form>
     <script>const WHO="boxes";${report}</script>`,
  ),
  ad: html(
    `<input name="email" placeholder="Ваш e-mail"><input name="promo">
     <script>const WHO="ad";${report}</script>`,
  ),
  // A 0x0 tracking frame whose field is named as temptingly as possible.
  pixel: html(
    `<input name="sms-code" autocomplete="one-time-code">
     <script>const WHO="pixel";${report}</script>`,
  ),
  pwd: html(
    `<input type="password" name="password">
     <script>const WHO="pwd";${report}</script>`,
  ),
  // An embedded field with no naming signal at all, merely focused — the
  // shape an unrelated widget has, and not enough to be handed a code.
  weak: html(
    `<input autofocus>
     <script>const WHO="weak";${report}</script>`,
  ),
  // The same frame, named the way a real challenge names itself.
  named: html(
    `<input name="smsCode" autofocus><button type="button">Подтвердить</button>
     <script>const WHO="named";${report}</script>`,
  ),
};

const OTHER = `http://127.0.0.1:${PORT}`;
const frame = (name: string, style = 'width="400" height="300"') =>
  `<iframe src="${OTHER}/frame/${name}" ${style}></iframe>`;

const cases: Record<string, string> = {
  // The real shape: merchant page, ad furniture, a 0x0 pixel, and the bank.
  ads3ds: html(
    `<h1>Оплата</h1><input name="search" placeholder="Поиск по сайту">
     ${frame("ad")}${frame("pixel", 'width="0" height="0" style="border:0"')}${frame("3ds")}
     <script>const WHO="top";${report}</script>`,
  ),
  // Top document holds the better field; the frame's is weaker. Top must win.
  topwins: html(
    `<input autocomplete="one-time-code" name="otp">${frame("3ds-plain")}
     <script>const WHO="top";${report}</script>`,
  ),
  // Same-origin (same renderer) frame — the isolated-world half of the walk.
  same: html(
    `<h1>Вход</h1><iframe src="/frame/3ds" width="400" height="300"></iframe>
     <script>const WHO="top";${report}</script>`,
  ),
  pay: html(`${frame("3ds-pay")}<script>const WHO="top";${report}</script>`),
  pwd: html(`${frame("pwd")}<script>const WHO="top";${report}</script>`),
  boxes: html(`${frame("boxes")}<script>const WHO="top";${report}</script>`),
  none: html(`<h1>Ничего</h1><p>Тут нет полей.</p><script>const WHO="top";${report}</script>`),
  weak: html(`${frame("weak")}<script>const WHO="top";${report}</script>`),
  named: html(`${frame("named")}<script>const WHO="top";${report}</script>`),
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (url.pathname === "/collect") {
    collected.push({
      who: url.searchParams.get("who") ?? "?",
      kind: url.searchParams.get("kind") ?? "?",
      value: url.searchParams.get("value") ?? "",
    });
    res.writeHead(204).end();
    return;
  }
  const frameName = url.pathname.startsWith("/frame/") ? url.pathname.slice(7) : undefined;
  const body = frameName ? frames[frameName] : cases[url.searchParams.get("case") ?? ""];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(body ?? "no");
});

const userDataDir = mkdtempSync(join(tmpdir(), "cdp-probe-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--remote-allow-origins=*",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--site-per-process",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${CDP}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("chromium did not expose CDP");
}

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

async function run(name: string): Promise<{
  result: Awaited<ReturnType<typeof cdpTypeIntoPage>>;
  got: typeof collected;
}> {
  collected.length = 0;
  await cdpNavigate(CDP, `http://localhost:${PORT}/?case=${name}`, 10_000);
  await sleep(600);
  const result = await cdpTypeIntoPage(CDP, CODE);
  await sleep(400);
  return { result, got: [...collected] };
}

try {
  await new Promise<void>((r) => server.listen(PORT, "0.0.0.0", () => r()));
  await waitForCdp();

  {
    const { result, got } = await run("ads3ds");
    const typedIn = got.filter((c) => c.kind === "input");
    check(result.typed && result.submitted === true, `ads3ds: typed+submitted (${JSON.stringify(result)})`);
    check(result.inFrame === true, "ads3ds: reported as an embedded frame");
    check(typedIn.length === 1 && typedIn[0]?.who === "3ds", `ads3ds: only the bank frame got it (${JSON.stringify(typedIn)})`);
    check(typedIn[0]?.value === CODE, "ads3ds: the whole code went in");
    check(got.some((c) => c.kind === "click" && c.who === "3ds"), "ads3ds: Подтвердить was clicked");
    check(!got.some((c) => c.who === "ad" || c.who === "pixel"), "ads3ds: ad and 0x0 pixel frames untouched");
  }
  {
    const { result, got } = await run("topwins");
    check(result.typed && !result.inFrame, `topwins: stayed in the top document (${JSON.stringify(result)})`);
    check(got.filter((c) => c.kind === "input").every((c) => c.who === "top"), "topwins: frame field untouched");
  }
  {
    const { result, got } = await run("same");
    check(result.typed === true && result.inFrame === true, `same-origin frame: typed (${JSON.stringify(result)})`);
    check(got.some((c) => c.kind === "input" && c.who === "3ds"), "same-origin frame: the field got it");
  }
  {
    const { result, got } = await run("pay");
    check(result.typed === true && result.submitted === false, `pay: typed but never submitted (${JSON.stringify(result)})`);
    check(!got.some((c) => c.kind === "click"), "pay: Оплатить was not clicked");
  }
  {
    const { result, got } = await run("pwd");
    check(result.typed === false, `password-only frame: nothing typed (${JSON.stringify(result)})`);
    check(got.length === 0, "password-only frame: field untouched");
  }
  {
    const { result, got } = await run("boxes");
    const typedIn = got.filter((c) => c.kind === "input");
    check(result.typed === true && result.partial !== true, `boxes: filled (${JSON.stringify(result)})`);
    check(typedIn.length === 6, `boxes: all six boxes (${typedIn.length})`);
    check(typedIn.map((c) => c.value).join("") === CODE, "boxes: digits in order");
  }
  {
    const { result, got } = await run("weak");
    check(result.typed === false, `weak frame: a bare focused input gets nothing (${JSON.stringify(result)})`);
    check(got.length === 0, "weak frame: field untouched");
  }
  {
    const { result, got } = await run("named");
    check(result.typed === true && result.inFrame === true, `named frame: a real challenge still gets it (${JSON.stringify(result)})`);
    check(got.some((c) => c.kind === "input" && c.value === CODE), "named frame: the whole code went in");
  }
  {
    const { result } = await run("none");
    check(result.typed === false, `none: nothing to type into (${JSON.stringify(result)})`);
    check((result.searched ?? 0) >= 1, "none: still searched the document");
  }
} finally {
  chrome.kill();
  server.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\ncdp-frames-probe ok" : `\ncdp-frames-probe: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
