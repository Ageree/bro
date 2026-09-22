import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { cdpProbeEnv } from "./env/cdp-probe.ts";
import { registerApplicationModuleResolution } from "./lib/module-resolution.ts";

/**
 * The one-time code entry, against a real browser.
 *
 *   npm run cdp:probe
 *
 * Which field on a page wins a code is decided by a program that runs inside
 * the browser, so `tests/agent/browser-use/cdp.test.ts` — which fakes the
 * protocol — cannot judge it. This can: it serves a page shaped like a real
 * checkout, with the code field inside a cross-site frame the way a bank's
 * 3-D Secure challenge always is, surrounded by the things that must not
 * receive a code, and checks where the digits actually landed.
 *
 * The page is served on `localhost` and its frames on `127.0.0.1` because
 * Chrome counts those as different sites: with `--site-per-process` the frame
 * then gets a renderer of its own, which is the case that used to be invisible.
 *
 * It drives a real browser, so it is not part of `pnpm check`, and it skips
 * rather than fails when no Chromium is installed. `CHROME_PATH` names one.
 */
registerApplicationModuleResolution();

const { typeOneTimeCodeOverCdp } = await import("@agent/lib/browser-use/cdp");

const targetListSchema = z.array(
  z.object({
    type: z.string().optional(),
    webSocketDebuggerUrl: z.string().optional(),
  })
);

const port = cdpProbeEnv.CDP_PROBE_PORT;
const debugPort = cdpProbeEnv.CDP_PROBE_DEBUG_PORT;
const debuggerUrl = `http://127.0.0.1:${String(debugPort)}`;
const code = "482913";
const chrome =
  cdpProbeEnv.CHROME_PATH ??
  [
    "/opt/pw-browsers/chromium",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].find((candidate) => existsSync(candidate));

if (!chrome) {
  console.log("cdp-probe skipped: no Chromium found (set CHROME_PATH)");
  process.exit(0);
}

interface Report {
  readonly kind: string;
  readonly value: string;
  readonly who: string;
}

const collected: Report[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><body style="margin:0">${body}</body>`;

// Every field reports what it received, so the assertions never read state back
// through the same protocol they are testing.
const reporting = `
  const send = (kind, el) => fetch("http://127.0.0.1:${String(port)}/collect?who=" + WHO + "&kind=" + kind + "&value=" + encodeURIComponent(el ? (el.value || "") : ""), { mode: "no-cors" });
  document.addEventListener("input", (event) => send("input", event.target), true);
  document.addEventListener("click", (event) => { if (event.target.closest("button")) send("click", null); }, true);
`;

const frames = new Map<string, string>(
  Object.entries({
    bank: page(
      `<form><input autocomplete="one-time-code" name="otp" placeholder="Код из СМС"><button type="button">Подтвердить</button></form>
     <script>const WHO="bank";${reporting}</script>`
    ),
    "bank-plain": page(
      `<form><input name="code"><button type="button">Подтвердить</button></form>
     <script>const WHO="bank-plain";${reporting}</script>`
    ),
    "bank-pay": page(
      `<form><input autocomplete="one-time-code" name="otp"><button type="button">Оплатить</button></form>
     <script>const WHO="bank-pay";${reporting}</script>`
    ),
    boxes: page(
      `<form>${'<input maxlength="1" inputmode="numeric">'.repeat(6)}<button type="button">Подтвердить</button></form>
     <script>const WHO="boxes";${reporting}</script>`
    ),
    ad: page(
      `<input name="email" placeholder="Ваш e-mail"><input name="promo">
     <script>const WHO="ad";${reporting}</script>`
    ),
    // A tracking frame with no size at all, whose field is named as temptingly
    // as a field can be named.
    pixel: page(
      `<input name="sms-code" autocomplete="one-time-code">
     <script>const WHO="pixel";${reporting}</script>`
    ),
    password: page(
      `<input type="password" name="password">
     <script>const WHO="password";${reporting}</script>`
    ),
    // Focused, and saying nothing about itself: what an unrelated widget looks
    // like, and not enough to be handed a code.
    weak: page(
      `<input autofocus><script>const WHO="weak";${reporting}</script>`
    ),
    named: page(
      `<input name="smsCode" autofocus><button type="button">Подтвердить</button>
     <script>const WHO="named";${reporting}</script>`
    ),
  })
);

const crossSite = `http://127.0.0.1:${String(port)}`;
const embed = (name: string, size = 'width="400" height="300"') =>
  `<iframe src="${crossSite}/frame/${name}" ${size}></iframe>`;

const cases = new Map<string, string>(
  Object.entries({
    // The real shape: a merchant page, advertising, a tracking pixel, the bank.
    checkout: page(
      `<h1>Оплата</h1><input name="search" placeholder="Поиск по сайту">
     ${embed("ad")}${embed("pixel", 'width="0" height="0" style="border:0"')}${embed("bank")}
     <script>const WHO="top";${reporting}</script>`
    ),
    // The page's own field says more about itself than the frame's, so it wins.
    "top-wins": page(
      `<input autocomplete="one-time-code" name="otp">${embed("bank-plain")}
     <script>const WHO="top";${reporting}</script>`
    ),
    // Same origin, so the frame shares the page's renderer: the other half of
    // the walk, reached through an isolated world rather than a session.
    "same-origin": page(
      `<h1>Вход</h1><iframe src="/frame/bank" width="400" height="300"></iframe>
     <script>const WHO="top";${reporting}</script>`
    ),
    pay: page(
      `${embed("bank-pay")}<script>const WHO="top";${reporting}</script>`
    ),
    password: page(
      `${embed("password")}<script>const WHO="top";${reporting}</script>`
    ),
    boxes: page(
      `${embed("boxes")}<script>const WHO="top";${reporting}</script>`
    ),
    weak: page(`${embed("weak")}<script>const WHO="top";${reporting}</script>`),
    named: page(
      `${embed("named")}<script>const WHO="top";${reporting}</script>`
    ),
    empty: page(
      `<h1>Ничего</h1><p>Тут нет полей.</p><script>const WHO="top";${reporting}</script>`
    ),
  })
);

const server = createServer((request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? ""}`
  );
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (url.pathname === "/collect") {
    collected.push({
      kind: url.searchParams.get("kind") ?? "?",
      value: url.searchParams.get("value") ?? "",
      who: url.searchParams.get("who") ?? "?",
    });
    response.writeHead(204).end();
    return;
  }
  const frameName = url.pathname.startsWith("/frame/")
    ? url.pathname.slice("/frame/".length)
    : undefined;
  const body =
    frameName === undefined
      ? cases.get(url.searchParams.get("case") ?? "")
      : frames.get(frameName);
  response.writeHead(body ? 200 : 404, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body ?? "no such page");
});

const userDataDir = mkdtempSync(join(tmpdir(), "cdp-probe-"));
const browser = spawn(
  chrome,
  [
    "--headless=new",
    `--remote-debugging-port=${String(debugPort)}`,
    "--remote-allow-origins=*",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--site-per-process",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

let failures = 0;
function check(passed: boolean, description: string) {
  console.log(`${passed ? "ok  " : "FAIL"} ${description}`);
  if (!passed) failures += 1;
}

// Recursion rather than a loop keeps each attempt one awaited step, the way
// the application's own waits are written.
async function waitForDebugger(attemptsLeft = 50): Promise<void> {
  if (attemptsLeft <= 0)
    throw new Error("Chromium never exposed its debugger.");
  const listening = await fetch(`${debuggerUrl}/json/version`)
    .then((response) => response.ok)
    .catch(() => false);
  if (listening) return;
  await sleep(200);
  await waitForDebugger(attemptsLeft - 1);
}

/** Chrome refuses a top-level navigation from the protocol's own page target
 *  less often than it refuses one from a fresh tab, so the page is opened the
 *  same way the application opens one: over the protocol. */
async function open(name: string) {
  collected.length = 0;
  const targets = targetListSchema.parse(
    await (await fetch(`${debuggerUrl}/json`)).json()
  );
  const target = targets.find((entry) => entry.type === "page") ?? targets[0];
  const socket = new WebSocket(target?.webSocketDebuggerUrl ?? "");
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => {
      reject(new Error("The probe browser exposed no debugger socket."));
    });
  });
  socket.send(
    JSON.stringify({
      id: 1,
      method: "Page.navigate",
      params: { url: `http://localhost:${String(port)}/?case=${name}` },
    })
  );
  await sleep(1_500);
  socket.close();
  const entry = await typeOneTimeCodeOverCdp(debuggerUrl, code);
  await sleep(400);
  return { entry, reports: [...collected] };
}

try {
  await new Promise<void>((resolve) => {
    server.listen(port, "0.0.0.0", () => {
      resolve();
    });
  });
  await waitForDebugger();

  {
    const { entry, reports } = await open("checkout");
    const typed = reports.filter((report) => report.kind === "input");
    check(
      entry.typed && entry.submitted,
      `checkout: typed and confirmed (${JSON.stringify(entry)})`
    );
    check(entry.inFrame, "checkout: reported as an embedded frame");
    check(
      typed.length === 1 && typed[0]?.who === "bank",
      `checkout: only the bank frame received it (${JSON.stringify(typed)})`
    );
    check(typed[0]?.value === code, "checkout: the whole code went in");
    check(
      reports.some(
        (report) => report.kind === "click" && report.who === "bank"
      ),
      "checkout: Подтвердить was pressed"
    );
    check(
      !reports.some((report) => report.who === "ad" || report.who === "pixel"),
      "checkout: the ad frame and the 0x0 pixel were left alone"
    );
  }
  {
    const { entry, reports } = await open("top-wins");
    check(
      entry.typed && !entry.inFrame,
      `top-wins: stayed in the page's own document (${JSON.stringify(entry)})`
    );
    check(
      reports
        .filter((report) => report.kind === "input")
        .every((report) => report.who === "top"),
      "top-wins: the frame's field was left alone"
    );
  }
  {
    const { entry, reports } = await open("same-origin");
    check(
      entry.typed && entry.inFrame,
      `same-origin: typed into the shared-renderer frame (${JSON.stringify(entry)})`
    );
    check(
      reports.some(
        (report) => report.kind === "input" && report.who === "bank"
      ),
      "same-origin: the field received it"
    );
  }
  {
    const { entry, reports } = await open("pay");
    check(
      entry.typed && !entry.submitted,
      `pay: typed but never submitted (${JSON.stringify(entry)})`
    );
    check(
      !reports.some((report) => report.kind === "click"),
      "pay: Оплатить was not pressed"
    );
  }
  {
    const { entry, reports } = await open("password");
    check(
      !entry.typed,
      `password: nothing was typed (${JSON.stringify(entry)})`
    );
    check(reports.length === 0, "password: the field was left alone");
  }
  {
    const { entry, reports } = await open("boxes");
    const typed = reports.filter((report) => report.kind === "input");
    check(
      entry.typed && !entry.partial,
      `boxes: filled (${JSON.stringify(entry)})`
    );
    check(typed.length === 6, `boxes: all six boxes (${String(typed.length)})`);
    check(
      typed.map((report) => report.value).join("") === code,
      "boxes: digits in order"
    );
  }
  {
    const { entry, reports } = await open("weak");
    check(
      !entry.typed,
      `weak frame: a bare focused input gets nothing (${JSON.stringify(entry)})`
    );
    check(reports.length === 0, "weak frame: the field was left alone");
  }
  {
    const { entry } = await open("named");
    check(
      entry.typed && entry.inFrame,
      `named frame: a real challenge still gets it (${JSON.stringify(entry)})`
    );
  }
  {
    const { entry } = await open("empty");
    check(
      !entry.typed,
      `empty: nothing to type into (${JSON.stringify(entry)})`
    );
    check(entry.searched >= 1, "empty: the document was still searched");
  }
} finally {
  const browserExited = new Promise<void>((resolve) => {
    if (browser.exitCode !== null) resolve();
    else
      browser.once("exit", () => {
        resolve();
      });
  });
  browser.kill();
  await Promise.race([browserExited, sleep(5_000)]);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  rmSync(userDataDir, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
}

console.log(
  failures === 0 ? "\ncdp-probe ok" : `\ncdp-probe: ${String(failures)} FAILED`
);
process.exit(failures === 0 ? 0 : 1);
