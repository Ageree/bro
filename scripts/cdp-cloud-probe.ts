import { registerApplicationModuleResolution } from "./lib/module-resolution.ts";

/**
 * The one-time code entry against a real Browser Use browser.
 *
 *   npm run cdp:probe:cloud
 *
 * `npm run cdp:probe` proves the entry against a browser we launch ourselves,
 * which answers "is this correct" but not "does the vendor let us do it".
 * Their Chrome could refuse a flattened auto-attach, or front the protocol
 * with something that drops the session id an embedded frame answers on, and
 * either would fail in production while every local test stayed green.
 *
 * So this takes the production path end to end: a real run, the browser it
 * opened, the same lookup the tool uses to find that browser — including once
 * the run itself is over, which is the case the shortcut exists for — and a
 * code typed into a field inside a frame.
 *
 * It spends real money: one run, cancelled as soon as its browser is up, plus
 * a browser-minute. The browser is always stopped afterwards, so nothing bills
 * on to the four-hour cap. It needs `BROWSER_USE_API_KEY` and skips without
 * one, which is why it is not part of `pnpm check`, and it reads `.env.local`
 * the way the application does — including `DATABASE_URL`, which the shared
 * environment insists on even though nothing here opens a database.
 */
import { z } from "zod";
import { cdpProbeEnv } from "./env/cdp-probe.ts";

registerApplicationModuleResolution();

if (cdpProbeEnv.BROWSER_USE_API_KEY === undefined) {
  console.log("cdp-cloud-probe skipped: no BROWSER_USE_API_KEY");
  process.exit(0);
}

const {
  cancelBrowserUseRun,
  createBrowserUseRun,
  findBrowserUseSessionCdpUrl,
  stopBrowserUseSession,
} = await import("@agent/lib/browser-use/client");
const { typeOneTimeCodeOverCdp } = await import("@agent/lib/browser-use/cdp");

const targetListSchema = z.array(
  z.object({
    type: z.string().optional(),
    webSocketDebuggerUrl: z.string().optional(),
  })
);

const evaluatedSchema = z.object({
  id: z.number().int().optional(),
  result: z
    .object({ result: z.object({ value: z.json() }).optional() })
    .optional(),
});

const code = "482913";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(passed: boolean, description: string) {
  console.log(`${passed ? "ok  " : "FAIL"} ${description}`);
  if (!passed) failures += 1;
}

/** Raw protocol, used only to BUILD the page under test; the code being tested
 *  opens its own connection the way it does in production. */
async function evaluate(cdpUrl: string, expression: string) {
  const targets = targetListSchema.parse(
    await (
      await fetch(
        `${cdpUrl.replace(/^wss?:/iu, "https:").replace(/\/$/u, "")}/json`
      )
    ).json()
  );
  const target = targets.find((entry) => entry.type === "page") ?? targets[0];
  const socket = new WebSocket(target?.webSocketDebuggerUrl ?? "");
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => {
      reject(new Error("The cloud browser exposed no debugger socket."));
    });
  });
  const answered = new Promise<z.infer<typeof evaluatedSchema>["result"]>(
    (resolve) => {
      socket.addEventListener("message", (event) => {
        // SAFETY: `JSON.parse` hands back `any`, and the schema is what turns it
        // into an answer before any field of it is read.
        const parsed = evaluatedSchema.safeParse(
          JSON.parse(String(event.data)) as unknown
        );
        if (parsed.success && parsed.data.id === 1) resolve(parsed.data.result);
      });
    }
  );
  socket.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { awaitPromise: false, expression, returnByValue: true },
    })
  );
  const answer = await answered;
  socket.close();
  return answer?.result?.value;
}

const run = await createBrowserUseRun({
  maxCostUsd: 0.05,
  task: "Open https://example.com and wait there. Do nothing else.",
});
console.log(`run ${run.id} in session ${run.sessionId}`);

try {
  // Recursion rather than a loop keeps each attempt one awaited step, the way
  // the application's own waits are written.
  const waitForBrowser = async (
    attemptsLeft: number
  ): Promise<string | undefined> => {
    if (attemptsLeft <= 0) return undefined;
    await sleep(1_500);
    const found = await findBrowserUseSessionCdpUrl(run.sessionId);
    return found ?? (await waitForBrowser(attemptsLeft - 1));
  };
  const cdpUrl = await waitForBrowser(40);
  check(cdpUrl !== undefined, "the tool's own lookup found the run's browser");
  if (!cdpUrl)
    throw new Error("The run never reported a browser to type into.");

  // From here the agent must not touch the page: what is being measured is
  // what the entry does, not what the agent does around it.
  await cancelBrowserUseRun(run.id);
  await sleep(2_000);
  const afterRun = await findBrowserUseSessionCdpUrl(run.sessionId);
  // The case the shortcut exists for: the person answers after the run ended,
  // and the browser is still there with the challenge on screen.
  check(
    afterRun !== undefined,
    "the browser is still reachable once its run is over"
  );

  await evaluate(
    cdpUrl,
    `(async () => {
      location.href = "https://example.com/";
      return "navigating";
    })()`
  );
  await sleep(3_000);
  await evaluate(
    cdpUrl,
    `(() => {
      document.open();
      document.write(\`
        <h1>Оплата</h1>
        <input name="search" placeholder="Поиск">
        <iframe width="500" height="300" srcdoc='
          <input autocomplete="one-time-code" name="otp">
          <button type="button">Подтвердить</button>
          <script>
            document.addEventListener("input", function (event) { parent.__got = event.target.value; }, true);
            document.addEventListener("click", function () { parent.__clicked = true; }, true);
          <\\/script>'></iframe>
        <iframe src="https://www.iana.org/" width="500" height="300"></iframe>\`);
      document.close();
      return "written";
    })()`
  );
  await sleep(4_000);

  const entry = await typeOneTimeCodeOverCdp(cdpUrl, code);
  console.log("entry", JSON.stringify(entry));
  await sleep(500);
  const landed = await evaluate(cdpUrl, "String(window.__got ?? '')");
  const pressed = await evaluate(cdpUrl, "Boolean(window.__clicked)");

  check(entry.typed, "the code was typed");
  check(entry.inFrame, "it landed in an embedded frame, not the page itself");
  check(
    landed === code,
    `the field holds the whole code (${JSON.stringify(landed)})`
  );
  check(pressed === true && entry.submitted, "Подтвердить was pressed");
  check(
    entry.searched >= 3,
    `the cross-site frame was reachable too — ${String(entry.searched)} contexts searched`
  );
} finally {
  try {
    await stopBrowserUseSession(run.sessionId);
    console.log("session stopped");
  } catch (error) {
    console.error("the session could not be stopped", error);
  }
}

console.log(
  failures === 0
    ? "\ncdp-cloud-probe ok"
    : `\ncdp-cloud-probe: ${String(failures)} FAILED`
);
process.exit(failures === 0 ? 0 : 1);
