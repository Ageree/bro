import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

let debuggerUrl = "";
const findBrowserUseSessionCdpUrl = vi.hoisted(() =>
  vi.fn<
    (sessionId: string, signal?: AbortSignal) => Promise<string | undefined>
  >(async () => debuggerUrl)
);

vi.mock("@agent/lib/browser-use/client", () => ({
  findBrowserUseSessionCdpUrl,
}));

import { verifyBrowserRun } from "@agent/lib/browser-use/verification";
import type { BrowserVerificationPlan } from "@shared/browser/verification";

const chrome = [
  "/opt/pw-browsers/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
].find(isExecutable);

const serverAddressSchema = z.object({ port: z.number().int().positive() });

const nativeFetch = globalThis.fetch;
let browser: ChildProcess | undefined;
let browserExit: Promise<BrowserExit> | undefined;
let browserStderr = "";
let pageServer: Server | undefined;
let pageUrl = "";
let profile = "";

describe.skipIf(!chrome)("browser verification against Chromium", () => {
  beforeAll(async () => {
    pageServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <style>.hidden-price { display: none }</style>
        <main id="app">
          <section id="offer"><h1 class="title">Blue mug</h1><p class="price">$19.99</p></section>
          <section id="offers">
            <article><h2 class="first-title">First mug</h2></article>
            <article><p class="second-price">$12.00</p></article>
          </section>
          <section id="stale"><p class="hidden-price">$1.00</p></section>
          <div style="opacity:0"><section id="ancestor-hidden"><p class="price">$1.00</p></section></div>
          <section id="hidden-child"><div class="visible-wrapper" style="padding:4px"><span hidden>$1.00</span></div></section>
          <section id="form"><input class="quantity" value="3"></section>
          <section id="formats">
            <time class="relative-date" datetime="2026-10-16T12:30:00Z">Tomorrow</time>
            <custom-date class="custom-date" datetime="2026-09-22 15:13:35 UTC">Published yesterday</custom-date>
            <custom-date class="hidden-custom-date" datetime="2026-09-22T15:13:35Z" hidden>Hidden date</custom-date>
            <custom-date id="access_token" datetime="2026-09-22T15:13:35Z">Sensitive date</custom-date>
            <time class="conflicting-date" datetime="2026-10-17">16 October 2026</time>
            <p class="russian-date">16 октября 2026 г.</p>
            <p class="russian-partial-date">15 октября</p>
            <p class="number-words">Two adults</p>
            <p class="unknown-identity">Release v4.2.0</p>
          </section>
          <section id="secret"><input class="password" type="password" value="never-return-this"></section>
          <section id="identifier-secrets">
            <input id="api_key" value="raw-api-secret">
            <div id="auth_token">raw-auth-secret</div>
          </section>
          <article id="outer-offer">
            <article><p class="inner-price">$12.00</p></article>
            <article><p class="inner-terms">Free delivery</p></article>
          </article>
          <table id="facts">
            <tr><td class="first-name">Mercury</td><td>First planet</td></tr>
            <tr><td>Venus</td><td class="second-date">2026-10-16</td></tr>
          </table>
          <section id="long-evidence">
            <p class="long-absence">${"a".repeat(1100)} forbidden phrase</p>
            <p class="long-number">$10.00 ${"b".repeat(1100)} $999.00</p>
          </section>
        </main>
        <script>
          Document.prototype.querySelectorAll = () => { throw new Error("main-world trap"); };
          Element.prototype.querySelectorAll = () => { throw new Error("main-world trap"); };
          JSON.stringify = () => "corrupted";
        </script>`);
    });
    const pagePort = await listen(pageServer);
    pageUrl = `http://127.0.0.1:${String(pagePort)}/confirmation`;
    profile = mkdtempSync(join(tmpdir(), "verification-chromium-"));
    browser = spawn(
      chrome ?? "",
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--remote-allow-origins=*",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        pageUrl,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    browser.stderr?.setEncoding("utf8");
    browser.stderr?.on("data", (chunk: string) => {
      browserStderr = `${browserStderr}${chunk}`.slice(-8_192);
    });
    browserExit = observeBrowserExit(browser);
    debuggerUrl = await waitForDebugger(browserExit);
  }, 15_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await Promise.all([
      stopBrowser(),
      pageServer ? closeServer(pageServer) : Promise.resolve(),
    ]);
    if (profile)
      rmSync(profile, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      });
  });

  it("reads visible DOM and safe form values in an isolated world", async () => {
    const report = await verify(
      [
        check("title", {
          caseSensitive: false,
          expected: "Blue mug",
          kind: "text_exact",
        }),
        check("quantity", {
          caseSensitive: true,
          expected: "3",
          kind: "text_exact",
        }),
      ],
      [
        locator("title", "#offer", ".title"),
        locator("quantity", "#form", ".quantity"),
      ]
    );

    expect(report.verdict).toBe("verified");
    expect(report.elapsedMs).toBeLessThanOrEqual(3_000);
  });

  it("verifies canonical dates, number words, and captured identity text", async () => {
    const report = await verify(
      [
        check("date", { expected: "2026-10-16", kind: "date" }),
        check("custom-date", { expected: "2026-09-22", kind: "date" }),
        check("localized-date", {
          kind: "date",
          maximum: "2026-12-31",
          minimum: "2026-01-01",
        }),
        check("localized-partial-date", {
          expected: "--10-15",
          kind: "date",
        }),
        check("quantity-words", {
          decimalSeparator: ".",
          kind: "number",
          maximum: 2,
          minimum: 2,
          numberWords: "en",
        }),
        {
          ...check("captured-name", { kind: "text_present" }),
          purpose: "identity",
        },
      ],
      [
        locator("date", "#formats", ".relative-date"),
        locator("custom-date", "#formats", ".custom-date"),
        locator("localized-date", "#formats", ".russian-date"),
        locator("localized-partial-date", "#formats", ".russian-partial-date"),
        locator("quantity-words", "#formats", ".number-words"),
        locator("captured-name", "#formats", ".unknown-identity"),
      ]
    );

    expect(report.verdict).toBe("verified");
    expect(report.observedChecks).toContainEqual(
      expect.objectContaining({
        checkId: "date",
        observation: "Tomorrow",
        value: "2026-10-16",
      })
    );
    expect(report.observedChecks).toContainEqual(
      expect.objectContaining({
        checkId: "custom-date",
        observation: "Published yesterday",
        value: "2026-09-22",
      })
    );
    expect(report.observedChecks).toContainEqual(
      expect.objectContaining({
        checkId: "captured-name",
        observation: "Release v4.2.0",
      })
    );
  });

  it("fails closed when visible and machine-readable dates disagree", async () => {
    const report = await verify(
      [check("date", { expected: "2026-10-16", kind: "date" })],
      [locator("date", "#formats", ".conflicting-date")]
    );

    expect(report.verdict).toBe("unverified");
    expect(report.defects[0]?.code).toBe("invalid_evidence");
  });

  it("does not use hidden or sensitive custom-element datetime evidence", async () => {
    const hidden = await verify(
      [check("date", { expected: "2026-09-22", kind: "date" })],
      [locator("date", "#formats", ".hidden-custom-date")]
    );
    const sensitive = await verify(
      [check("date", { expected: "2026-09-22", kind: "date" })],
      [locator("date", "#formats", "#access_token")]
    );

    expect(hidden.verdict).toBe("unverified");
    expect(hidden.defects[0]?.code).toBe("invalid_evidence");
    expect(sensitive.verdict).toBe("unverified");
    expect(sensitive.defects[0]?.code).toBe("sensitive_evidence");
  });

  it("rejects resolved body aliases and hidden stale values", async () => {
    const broad = await verify(
      [
        check("title", {
          caseSensitive: false,
          expected: "Blue mug",
          kind: "text_exact",
        }),
      ],
      [locator("title", ":is(body)", "#offer .title")]
    );
    const hidden = await verify(
      [
        check("price", {
          currency: "USD",
          decimalSeparator: ".",
          kind: "number",
          maximum: 5,
        }),
      ],
      [locator("price", "#stale", ".hidden-price")]
    );
    const hiddenByAncestor = await verify(
      [
        check("price", {
          currency: "USD",
          decimalSeparator: ".",
          kind: "number",
          maximum: 5,
        }),
      ],
      [locator("price", "#ancestor-hidden", ".price")]
    );
    const hiddenChild = await verify(
      [
        check("price", {
          currency: "USD",
          decimalSeparator: ".",
          kind: "number",
          maximum: 5,
        }),
      ],
      [locator("price", "#hidden-child", ".visible-wrapper")]
    );

    expect(broad.verdict).toBe("unverified");
    expect(hidden.verdict).toBe("unverified");
    expect(hiddenByAncestor.verdict).toBe("unverified");
    expect(hiddenChild.verdict).toBe("unverified");
  });

  it("distinguishes zero, multiple, and grouped-missing DOM matches", async () => {
    const zero = await verify(
      [
        check("title", {
          caseSensitive: false,
          expected: "Blue mug",
          kind: "text_exact",
        }),
      ],
      [locator("title", "#offer", "#offer")]
    );
    const multiple = await verify(
      [
        check("candidate", {
          caseSensitive: false,
          expected: "First mug",
          kind: "text_contains",
        }),
      ],
      [locator("candidate", "#offers", "article")]
    );
    const groupedChecks = [
      {
        ...check("title", {
          caseSensitive: false,
          expected: "Blue mug",
          kind: "text_exact",
        }),
        groupId: "offer",
      },
      {
        ...check("price", {
          currency: "USD",
          decimalSeparator: ".",
          kind: "number",
          maximum: 20,
        }),
        groupId: "offer",
      },
    ] satisfies BrowserVerificationPlan["checks"];
    const grouped = await verify(groupedChecks, [
      locator("title", "#offer", ".missing-title"),
      locator("price", "#offer", ".price"),
    ]);

    expect(zero.defects[0]?.code).toBe("missing_evidence");
    expect(multiple.defects[0]?.code).toBe("ambiguous_match");
    expect(grouped.defects).toContainEqual(
      expect.objectContaining({ checkId: "title", code: "missing_evidence" })
    );
    expect(grouped.defects.some(({ code }) => code === "group_mismatch")).toBe(
      false
    );
  });

  it("never returns a sensitive form value", async () => {
    const report = await verify(
      [
        check("password", {
          caseSensitive: true,
          expected: "never-return-this",
          kind: "text_exact",
        }),
      ],
      [locator("password", "#secret", ".password")]
    );

    expect(report.verdict).toBe("unverified");
    expect(report.defects[0]?.code).toBe("sensitive_evidence");
    expect(JSON.stringify(report)).not.toContain("never-return-this");
  });

  it("never reads token or API-key identifier evidence", async () => {
    const apiKey = await verify(
      [
        check("api-secret", {
          caseSensitive: true,
          expected: "raw-api-secret",
          kind: "text_exact",
        }),
      ],
      [locator("api-secret", "#identifier-secrets", "#api_key")]
    );
    const authToken = await verify(
      [
        check("auth-secret", {
          caseSensitive: true,
          expected: "raw-auth-secret",
          kind: "text_exact",
        }),
      ],
      [locator("auth-secret", "#identifier-secrets", "#auth_token")]
    );

    expect(apiKey.defects[0]?.code).toBe("sensitive_evidence");
    expect(authToken.defects[0]?.code).toBe("sensitive_evidence");
    expect(JSON.stringify([apiKey, authToken])).not.toMatch(
      /raw-(?:api|auth)-secret/u
    );
  });

  it("rejects grouped fields resolved from different candidate containers", async () => {
    const checks = [
      {
        ...check("title", {
          caseSensitive: false,
          expected: "First mug",
          kind: "text_exact",
        }),
        groupId: "offer",
      },
      {
        ...check("price", {
          currency: "USD",
          decimalSeparator: ".",
          kind: "number",
          maximum: 20,
        }),
        groupId: "offer",
      },
      {
        ...check("terms", {
          caseSensitive: false,
          expected: "Free delivery",
          kind: "text_contains",
        }),
        groupId: "offer",
        mandatory: false,
      },
    ] satisfies BrowserVerificationPlan["checks"];

    const report = await verify(checks, [
      locator("title", "#offers", ".first-title"),
      locator("price", "#offers", ".second-price"),
      locator("terms", "#offers", ".missing-terms"),
    ]);

    expect(report.verdict).toBe("unverified");
    expect(report.defects.some(({ code }) => code === "group_mismatch")).toBe(
      true
    );
  });

  it("rejects grouped fields resolved from different semantic table rows", async () => {
    const checks = [
      {
        ...check("name", { kind: "text_present" }),
        groupId: "fact",
        purpose: "identity" as const,
      },
      {
        ...check("date", { expected: "2026-10-16", kind: "date" }),
        groupId: "fact",
      },
    ] satisfies BrowserVerificationPlan["checks"];

    const report = await verify(checks, [
      locator("name", "#facts", ".first-name"),
      locator("date", "#facts", ".second-date"),
    ]);

    expect(report.verdict).toBe("unverified");
    expect(report.defects.some(({ code }) => code === "group_mismatch")).toBe(
      true
    );
  });

  it("prefers nested candidate identity over an outer candidate scope", async () => {
    const checks = [
      {
        ...check("price", {
          currency: "USD",
          decimalSeparator: ".",
          kind: "number",
          maximum: 20,
        }),
        groupId: "offer",
      },
      {
        ...check("terms", {
          caseSensitive: false,
          expected: "Free delivery",
          kind: "text_exact",
        }),
        groupId: "offer",
      },
    ] satisfies BrowserVerificationPlan["checks"];

    const report = await verify(checks, [
      locator("price", "#outer-offer", ".inner-price"),
      locator("terms", "#outer-offer", ".inner-terms"),
    ]);

    expect(report.verdict).toBe("unverified");
    expect(report.defects.some(({ code }) => code === "group_mismatch")).toBe(
      true
    );
  });

  it("never decides absence or numeric bounds from truncated text", async () => {
    const absence = await verify(
      [
        check("absence", {
          caseSensitive: false,
          expected: "forbidden phrase",
          kind: "text_absent",
        }),
      ],
      [locator("absence", "#long-evidence", ".long-absence")]
    );
    const numeric = await verify(
      [
        check("number", {
          currency: "USD",
          decimalSeparator: ".",
          kind: "number",
          maximum: 20,
        }),
      ],
      [locator("number", "#long-evidence", ".long-number")]
    );

    expect(absence.verdict).toBe("unverified");
    expect(numeric.verdict).toBe("unverified");
  });

  it("uses the live isolated-world URL instead of a stale target URL", async () => {
    const staleUrl = `${pageUrl}?stale=1`;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await nativeFetch(input, init);
        const requestedUrl =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        if (requestedUrl !== `${debuggerUrl}/json`) return response;
        const targets = z
          .array(
            z.looseObject({
              type: z.string().optional(),
              url: z.string().optional(),
            })
          )
          .parse(await response.json());
        for (const target of targets) {
          if (target.type === "page") target.url = staleUrl;
        }
        return Response.json(targets);
      }
    );
    const report = await verify(
      [
        check("title", {
          caseSensitive: false,
          expected: "Blue mug",
          kind: "text_exact",
        }),
      ],
      [locator("title", "#offer", ".title", staleUrl)]
    );
    vi.unstubAllGlobals();

    expect(report.verdict).toBe("unverified");
    expect(report.defects[0]?.code).toBe("page_missing");
  });
});

function check(
  id: string,
  predicate: BrowserVerificationPlan["checks"][number]["predicate"]
) {
  return { description: id, id, mandatory: true, predicate };
}

function locator(
  checkId: string,
  scopeSelector: string,
  selector: string,
  source = pageUrl
) {
  return { checkId, pageUrl: source, scopeSelector, selector };
}

function verify(
  checks: BrowserVerificationPlan["checks"],
  locators: ReturnType<typeof locator>[]
) {
  return verifyBrowserRun({
    plan: { checks, version: 1 },
    result: `RESULT: done\nNEEDS: none\nCHECKS: ${JSON.stringify({ checks: locators, version: 1 })}`,
    sessionId: "probe-session",
  });
}

function listen(server: Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const parsed = serverAddressSchema.safeParse(address);
      if (!parsed.success) throw new Error("The probe server has no TCP port.");
      resolve(parsed.data.port);
    });
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

type BrowserExit =
  | { code: number | null; kind: "exit"; signal: NodeJS.Signals | null }
  | { error: Error; kind: "error" };

function isExecutable(candidate: string | undefined): candidate is string {
  if (!candidate || !existsSync(candidate)) return false;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function observeBrowserExit(child: ChildProcess) {
  return new Promise<BrowserExit>((resolve) => {
    child.once("error", (error) => {
      resolve({ error, kind: "error" });
    });
    child.once("exit", (code, signal) => {
      resolve({ code, kind: "exit", signal });
    });
  });
}

async function waitForDebugger(
  exited: Promise<BrowserExit>,
  deadline = Date.now() + 10_000
): Promise<string> {
  if (Date.now() >= deadline) throw browserStartupError();
  const activePortFile = join(profile, "DevToolsActivePort");
  const outcome = await Promise.race([
    exited,
    new Promise<undefined>((resolve) => {
      setTimeout(resolve, 50);
    }),
  ]);
  if (outcome) throw browserStartupError(outcome);
  if (existsSync(activePortFile)) {
    let port: number;
    try {
      port = Number.parseInt(
        readFileSync(activePortFile, "utf8").split("\n", 1)[0] ?? "",
        10
      );
    } catch {
      return waitForDebugger(exited, deadline);
    }
    if (Number.isInteger(port) && port > 0) {
      const url = `http://127.0.0.1:${String(port)}`;
      const ready = await nativeFetch(`${url}/json/version`, {
        signal: AbortSignal.timeout(250),
      })
        .then((response) => response.ok)
        .catch(() => false);
      if (ready) return url;
    }
  }
  return waitForDebugger(exited, deadline);
}

function browserStartupError(outcome?: BrowserExit) {
  const reason = outcome
    ? outcome.kind === "error"
      ? `spawn failed: ${outcome.error.message}`
      : `exited with code ${String(outcome.code)} and signal ${String(outcome.signal)}`
    : "did not expose its debugger within 10 seconds";
  const diagnostics = browserStderr
    .replace(/(?:https?|wss?):\/\/\S+/gu, "<redacted-browser-endpoint>")
    .trim();
  return new Error(
    `Chromium ${reason} (${chrome ?? "no executable selected"}).${diagnostics ? ` stderr: ${diagnostics}` : ""}`
  );
}

async function stopBrowser() {
  if (!browser || !browserExit) return;
  if (browser.exitCode !== null || browser.signalCode !== null) return;
  browser.kill("SIGTERM");
  const stopped = await Promise.race([
    browserExit.then(() => true),
    new Promise<false>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, 2_000);
    }),
  ]);
  if (stopped) return;
  browser.kill("SIGKILL");
  await browserExit;
}
