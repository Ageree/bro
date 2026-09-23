import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  browserEvalEnv,
  prepareBrowserEvalEnvironment,
} from "../env/browser-eval.ts";
import { registerApplicationModuleResolution } from "../lib/module-resolution.ts";
import { browserEvalFixtures, browserEvalTaskIds } from "./fixtures.ts";

registerApplicationModuleResolution();

const artifactRoot = join(homedir(), ".capy", "work", "browser-eval");
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const timedOutRunIds = new Set<string>();

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function positiveNumber(name: string, fallback: number) {
  const raw = option(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

const requestedTaskId = option("--task");
const variant = option("--variant") ?? "current";
const withContinuation = process.argv.includes("--continue");
const maxCostUsd = positiveNumber("--max-cost", 0.5);
const timeoutMs = positiveNumber("--timeout-ms", 12 * 60_000);
const pollMs = positiveNumber("--poll-ms", 3_000);

if (process.argv.includes("--list")) {
  console.log(browserEvalTaskIds.join("\n"));
  process.exit(0);
}
const selectedFixture = Object.entries(browserEvalFixtures).find(
  ([taskId]) => taskId === requestedTaskId
);
if (!selectedFixture) {
  console.error(
    `Choose one task with --task: ${browserEvalTaskIds.join(", ")}`
  );
  process.exit(2);
}
if (variant !== "current" && variant !== "baseline") {
  console.error("--variant must be current or baseline.");
  process.exit(2);
}
const [selectedTaskId, fixture] = selectedFixture;
if (withContinuation && !fixture.continuation) {
  console.error(`${selectedTaskId} has no continuation fixture.`);
  process.exit(2);
}

await mkdir(artifactRoot, { recursive: true });
const startedAt = new Date();
const slug = `${startedAt.toISOString().replaceAll(/[:.]/gu, "-")}-${selectedTaskId}-${variant}`;
const artifactDirectory = join(artifactRoot, slug);
await mkdir(artifactDirectory, { recursive: true });

if (!browserEvalEnv.BROWSER_USE_API_KEY) {
  await writeFile(
    join(artifactDirectory, "blocked.json"),
    `${JSON.stringify(
      {
        reason: "BROWSER_USE_API_KEY is not configured.",
        status: "blocked",
        taskId: selectedTaskId,
        variant,
      },
      null,
      2
    )}\n`
  );
  console.error(
    `blocked: BROWSER_USE_API_KEY is not configured (${artifactDirectory})`
  );
  process.exit(2);
}

prepareBrowserEvalEnvironment();

const client = await import("@agent/lib/browser-use/client");
const { env } = await import("@shared/environment");
const {
  parseBrowserOutcome,
  resolvedBrowserOutcomeStatus,
  sanitizeBrowserOutput,
} = await import("@agent/lib/browser-use/outcome");
const { composeBrowserTask, composeBrowserContinuation } =
  await import("@agent/tools/browser_task");

const baselineCredentials =
  "No stored credentials are available for this run. If the site asks you to sign in, stop with NEEDS: password instead of guessing one.";
const baselineCaptcha = [
  "Getting past a CAPTCHA or anti-bot check is part of this errand, not a reason to end it: solve it yourself, right away, and stay on it until the page lets you through — drag the slider, tick «I am not a robot», hold the button, pick the tiles, read out the characters. The browser you are in also solves supported challenges on its own, so a check that is already resolving needs a moment rather than a fight.",
  "Work it at a human pace. If an attempt does not take, try it again, and again after that; a check that comes back on the next page is the same job, not a verdict.",
  "This is never the person's job: they cannot see your screen and will not be asked to do it for you.",
  "Stop with NEEDS: captcha only once the page still blocks you after all of that, and put in DETAILS what it shows.",
].join(" ");
const baselineOutcome = [
  "Finish your final answer with these labelled lines, written in the language of the errand above:",
  "RESULT: what was actually accomplished, or why it stopped",
  "ORDER: the order, booking, or reference number, or none",
  "TOTAL: the amount charged or shown, or none",
  "NEEDS: exactly one of none, sms_code, email_code, push, 3ds, captcha, password, address, payment, decision, info",
  "DETAILS: the one thing a person must supply or decide, or none",
].join("\n");

function baselinePrompt(task: string, continuation?: string) {
  return continuation
    ? [
        continuation,
        `This continues the errand «${task}» in this same browser session. Keep the tab that is open and the account already signed in: do not start over and do not navigate again unless the page is gone.\nSite: https://github.com`,
        baselineCredentials,
        baselineCaptcha,
        baselineOutcome,
      ].join("\n\n")
    : [task, baselineCredentials, baselineCaptcha, baselineOutcome].join(
        "\n\n"
      );
}

function promptFor(task: string) {
  return variant === "current"
    ? composeBrowserTask({
        aliases: [],
        errand: task,
        facts: undefined,
        site: undefined,
      })
    : baselinePrompt(task);
}

function continuationPrompt(message: string, checkpoint: string) {
  return variant === "current"
    ? composeBrowserContinuation({
        aliases: [],
        checkpoint,
        errand: fixture.task,
        facts: undefined,
        message,
        site: "https://github.com",
      })
    : baselinePrompt(fixture.task, message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTerminal(runId: string) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<
    Awaited<ReturnType<typeof client.readBrowserUseRun>>
  > => {
    const status = await client.readBrowserUseRunStatus(runId);
    process.stdout.write(`\r${runId} ${status}   `);
    if (terminalStatuses.has(status)) {
      process.stdout.write("\n");
      return client.readBrowserUseRun(runId);
    }
    if (Date.now() < deadline) {
      await sleep(pollMs);
      return poll();
    }
    process.stdout.write("\n");
    await client.cancelBrowserUseRun(runId);
    timedOutRunIds.add(runId);
    return client.readBrowserUseRun(runId);
  };
  return poll();
}

async function allEvents(runId: string) {
  type Events = Awaited<
    ReturnType<typeof client.listBrowserUseRunEvents>
  >["events"];
  const readPage = async (
    after: number,
    pagesLeft: number,
    events: Events,
    seenCursors: ReadonlySet<number>
  ): Promise<Events> => {
    if (pagesLeft <= 0) throw new Error("Event pagination exceeded 20 pages.");
    const page = await client.listBrowserUseRunEvents(runId, 200, after);
    const collected = [...events, ...page.events];
    if (
      !page.hasMore ||
      page.nextAfter === null ||
      page.nextAfter === undefined
    ) {
      return collected;
    }
    if (seenCursors.has(page.nextAfter)) {
      throw new Error(
        `Event pagination repeated cursor ${String(page.nextAfter)}.`
      );
    }
    const nextSeenCursors = new Set(seenCursors);
    nextSeenCursors.add(page.nextAfter);
    return readPage(page.nextAfter, pagesLeft - 1, collected, nextSeenCursors);
  };
  return readPage(0, 20, [], new Set());
}

const jsonValueSchema = z.json();
const jsonStringSchema = z.string();
const jsonArraySchema = z.array(jsonValueSchema);
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
type BrowserEventValue = z.infer<typeof jsonValueSchema>;

function screenshotUrls(value: BrowserEventValue, key = ""): string[] {
  const stringValue = jsonStringSchema.safeParse(value);
  if (stringValue.success) {
    if (
      !/(?:screenshot|image)/iu.test(key) ||
      !URL.canParse(stringValue.data)
    ) {
      return [];
    }
    const protocol = new URL(stringValue.data).protocol;
    return protocol === "http:" || protocol === "https:"
      ? [stringValue.data]
      : [];
  }
  const arrayValue = jsonArraySchema.safeParse(value);
  if (arrayValue.success) {
    return arrayValue.data.flatMap((item) => screenshotUrls(item, key));
  }
  const objectValue = jsonObjectSchema.safeParse(value);
  if (objectValue.success) {
    return Object.entries(objectValue.data).flatMap(([childKey, child]) =>
      screenshotUrls(child, childKey)
    );
  }
  return [];
}

function sanitizedEventData(
  value: BrowserEventValue,
  key = ""
): BrowserEventValue {
  if (
    /live|cdp|cookie|authorization|password|passcode|otp|secret|token/iu.test(
      key
    )
  ) {
    return "[redacted]";
  }
  const stringValue = jsonStringSchema.safeParse(value);
  if (/(?:screenshot|image)/iu.test(key) && stringValue.success) {
    return "[captured separately when available]";
  }
  if (stringValue.success)
    return sanitizeBrowserOutput(stringValue.data, 2_000);
  const arrayValue = jsonArraySchema.safeParse(value);
  if (arrayValue.success) {
    return arrayValue.data
      .slice(0, 100)
      .map((item) => sanitizedEventData(item, key));
  }
  const objectValue = jsonObjectSchema.safeParse(value);
  if (objectValue.success) {
    return Object.fromEntries(
      Object.entries(objectValue.data)
        .slice(0, 100)
        .map(([childKey, child]) => [
          childKey,
          sanitizedEventData(child, childKey),
        ])
    );
  }
  return value;
}

async function captureArtifacts(runId: string, prefix: string) {
  const events = await allEvents(runId);
  const urls = [
    ...new Set(events.flatMap((event) => screenshotUrls(event.data))),
  ].slice(-6);
  const captureScreenshot = async (url: string, index: number) => {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.startsWith("image/")) return undefined;
      const maximumBytes = 5 * 1024 * 1024;
      const declaredBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes)
        return undefined;
      if (!response.body) return undefined;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > maximumBytes) {
          throw new Error("Screenshot exceeded 5 MiB.");
        }
        chunks.push(chunk);
      }
      const extension = contentType.includes("png") ? "png" : "jpg";
      const filename = `${prefix}-screenshot-${String(index + 1)}.${extension}`;
      await writeFile(join(artifactDirectory, filename), Buffer.concat(chunks));
      return filename;
    } catch {
      return undefined;
    }
  };
  const captured = await Promise.all(
    urls.map((url, index) => captureScreenshot(url, index))
  );
  const screenshots = captured.filter((filename) => filename !== undefined);
  await writeFile(
    join(artifactDirectory, `${prefix}-events.json`),
    `${JSON.stringify(
      events.map((event) => ({
        data: sanitizedEventData(event.data),
        id: event.id,
        ts: event.ts,
        type: event.type,
      })),
      null,
      2
    )}\n`
  );
  return screenshots;
}

function exactLinks(text: string) {
  return [...new Set(text.match(/https?:\/\/[^\s)\]}>,]+/giu) ?? [])];
}

let sessionId: string | undefined;
let activeRunId: string | undefined;
let executionError: string | undefined;

async function executeRun(task: string, prefix: string, reuseSession?: string) {
  const runStartedAt = Date.now();
  const created = await client.createBrowserUseRun({
    maxCostUsd,
    model: env.BROWSER_USE_MODEL,
    proxyCountryCode: env.BROWSER_USE_PROXY_COUNTRY,
    sessionId: reuseSession,
    task,
  });
  sessionId = created.sessionId;
  activeRunId = created.id;
  console.log(
    `${prefix}: run ${created.id}, session ${created.sessionId}, model ${created.model}`
  );
  const summary = await waitForTerminal(created.id);
  activeRunId = undefined;
  const rawAnswer = sanitizeBrowserOutput(summary.result ?? "", 30_000);
  let screenshots: string[] = [];
  let evidenceError: string | undefined;
  try {
    screenshots = await captureArtifacts(created.id, prefix);
  } catch (error) {
    evidenceError = sanitizeBrowserOutput(
      error instanceof Error ? error.message : String(error),
      2_000
    );
  }
  const parsed = parseBrowserOutcome(summary.result);
  const record = {
    createdModel: created.model,
    durationMs: Date.now() - runStartedAt,
    evidenceError,
    exactLinks: exactLinks(rawAnswer),
    model: summary.model ?? created.model,
    parsedTaskStatus: resolvedBrowserOutcomeStatus(parsed),
    promptSha256: createHash("sha256").update(summary.task).digest("hex"),
    providerError:
      sanitizeBrowserOutput(summary.error ?? "", 2_000) || undefined,
    providerStatus: summary.status,
    rawAnswer,
    runId: created.id,
    screenshots,
    sessionId: created.sessionId,
    totalCostUsd: summary.totalCostUsd,
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    timedOut: timedOutRunIds.has(created.id),
  };
  return record;
}

const records: Awaited<ReturnType<typeof executeRun>>[] = [];

function runError(record: Awaited<ReturnType<typeof executeRun>>) {
  if (record.timedOut) {
    return `Run ${record.runId} exceeded ${String(timeoutMs)}ms and was cancelled.`;
  }
  return record.providerStatus === "completed"
    ? undefined
    : `Run ${record.runId} ended as ${record.providerStatus}.`;
}

try {
  const initial = await executeRun(promptFor(fixture.task), "initial");
  records.push(initial);
  executionError = runError(initial);
  const continuation = fixture.continuation;
  if (!executionError && withContinuation && continuation && sessionId) {
    const continued = await executeRun(
      continuationPrompt(continuation, initial.rawAnswer),
      "continuation",
      sessionId
    );
    records.push(continued);
    executionError = runError(continued);
  }
} catch (error) {
  executionError = sanitizeBrowserOutput(
    error instanceof Error ? error.message : String(error),
    2_000
  );
  if (activeRunId) {
    try {
      await client.cancelBrowserUseRun(activeRunId);
    } catch (cancellationError) {
      executionError ??= sanitizeBrowserOutput(
        `Run cancellation failed: ${cancellationError instanceof Error ? cancellationError.message : String(cancellationError)}`,
        2_000
      );
    }
  }
} finally {
  if (sessionId) {
    try {
      await client.stopBrowserUseSession(sessionId);
    } catch (cleanupError) {
      executionError ??= sanitizeBrowserOutput(
        `Session cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        2_000
      );
    }
  }
}

const report = {
  configuration: {
    continuation: withContinuation,
    maxCostUsdPerRun: maxCostUsd,
    pollMs,
    proxyCountryCode: env.BROWSER_USE_PROXY_COUNTRY,
    timeoutMsPerRun: timeoutMs,
  },
  durationMs: Date.now() - startedAt.getTime(),
  error: executionError,
  evaluationBoundary:
    "Hosted production prompt plus Browser Use provider client; this bypasses browser_task database persistence and completion delivery.",
  baselinePromptRevision: "agent/tools/browser_task.ts@7565dd7",
  fixtureRevision: "browser-eval fixtures authored 2026-09-22",
  ponytailRevision: "v4.9.0 read-only SKILL.md; no hooks installed",
  records,
  status: executionError ? "blocked" : "awaiting_independent_review",
  taskId: selectedTaskId,
  variant,
};
await writeFile(
  join(artifactDirectory, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`
);
await writeFile(
  join(artifactDirectory, "manual-score.md"),
  [
    `# Browser eval: ${selectedTaskId} (${variant})`,
    "",
    `Run status: **${report.status}**. Provider/model self-report is not a pass verdict.`,
    "",
    "## Independent criteria",
    "",
    ...fixture.criteria.map((criterion) => `- [ ] ${criterion}`),
    "- [ ] Open the saved event trace and screenshots and verify the cited pages support the answer.",
    "- [ ] Confirm no prohibited external side effect occurred.",
    "",
    "## Reviewer verdict",
    "",
    "- Verdict: awaiting review",
    "- Notes:",
    "",
  ].join("\n")
);

console.log(`artifacts: ${artifactDirectory}`);
process.exit(executionError ? 1 : 0);
