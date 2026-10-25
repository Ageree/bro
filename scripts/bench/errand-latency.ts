import { Client, type MessageStreamEvent } from "eve/client";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as z from "zod";
import { isBackgroundTurnText } from "../../shared/chat/background-turn.ts";
import { benchEnv } from "../env/bench.ts";
import { defaultCookieFile, readCookieHeader } from "./cookies.ts";
import { signedInSession } from "./sign-in.ts";

/**
 * How long a person waits for a browser errand's result (19.10): sends
 * `--text` as a new web conversation and follows the session past the turn
 * that answered, to the errand's report turn, printing one JSON line with
 * the milliseconds from the POST to each boundary that matters:
 *
 *   - `firstMessage` — Bro's first `send_message` (the heads-up);
 *   - `browserTask` — the `browser_task` result (`running`, `queued`…);
 *   - `report` — the «Browser run … finished» message reaching the session;
 *   - `result` — the report turn's `send_message`, what the person reads,
 *     or, when `browser_task` answered from the site's own data with no
 *     run (`status: "found"`, `site-ops/direct.ts`), the turn's own message
 *     after it.
 *
 * Each `--text` is one run, in its own conversation; `--runs` repeats the
 * list. Reads only the sessions it opens.
 *
 *   NODE_USE_ENV_PROXY=1 node --experimental-strip-types \
 *     scripts/bench/errand-latency.ts --text "сколько стоит … на Маркете?"
 */

const { values: flags } = parseArgs({
  options: {
    "cookie-file": { type: "string" },
    "gap-s": { default: "30", type: "string" },
    host: { type: "string" },
    runs: { default: "1", type: "string" },
    text: { multiple: true, type: "string" },
    "timeout-s": { default: "900", type: "string" },
  },
});

const host = new URL(flags.host ?? benchEnv.BENCH_HOST);
const cookie = await readCookieHeader(
  resolve(
    flags["cookie-file"] ?? benchEnv.BENCH_COOKIE_FILE ?? defaultCookieFile
  ),
  host
);
await signedInSession(host, cookie);
const client = new Client({
  headers: { cookie, origin: host.origin },
  host: host.origin,
  // A redirect here is the sign-in page; never follow it with the cookie.
  redirect: "manual",
});

const texts = flags.text ?? [];
if (texts.length === 0) throw new Error("--text is required");
const runs = Number(flags.runs);
const gapMs = Number(flags["gap-s"]) * 1000;
const timeoutMs = Number(flags["timeout-s"]) * 1000;

const reportPattern = /^Browser run (\S+) finished\./mu;
/** What a turn's own text says when `send_message` already answered. */
const bookkeeping = /^\s*(?:DELIVERY_COMPLETE|<eve-empty-delivery\/>)?\s*$/u;

const sendSchema = z.object({
  input: z.object({ text: z.string() }),
  toolName: z.literal("send_message"),
});

const browserResultSchema = z.object({
  output: z.object({ runId: z.string().optional(), status: z.string() }),
  toolName: z.literal("browser_task"),
});

async function errand(text: string) {
  const started = Date.now();
  const opened = await client.sessions.create({ message: text });
  const { session } = opened;
  const marks: Record<string, number | string | undefined> = {};
  const sends: { at: number; text: string; turn: number }[] = [];
  const tools: { at: number; name: string; turn: number }[] = [];
  let turn = -1;
  let reportTurn: number | undefined;
  // The turn whose `browser_task` answered from the site's data itself.
  let foundTurn: number | undefined;
  let done = false;
  const since = (event: MessageStreamEvent) =>
    Date.parse(event.meta.at) - started;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  let index = 0;
  try {
    // A stream gives up after a few idle reconnects, far sooner than an
    // errand reports, so it is reopened from the cursor until the result.
    while (!done && !controller.signal.aborted) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one stream at a time, reopened in order
        for await (const event of session.stream({
          signal: controller.signal,
          startIndex: index,
        })) {
          index += 1;
          const at = since(event);
          if (!event.type.endsWith(".appended")) {
            console.error(`${(at / 1000).toFixed(1)} ${event.type}`);
          }
          switch (event.type) {
            case "turn.started":
              turn += 1;
              break;
            case "message.received": {
              const { message } = event.data;
              const run = isBackgroundTurnText(message)
                ? reportPattern.exec(message)?.[1]
                : undefined;
              if (run !== undefined && marks.report === undefined) {
                marks.report = at;
                reportTurn = turn;
              }
              break;
            }
            case "actions.requested":
              for (const action of event.data.actions) {
                const name = "toolName" in action ? action.toolName : "";
                tools.push({ at, name, turn });
                const said = sendSchema.safeParse(action);
                if (!said.success) continue;
                sends.push({
                  at,
                  text: said.data.input.text.slice(0, 400),
                  turn,
                });
                marks.firstMessage ??= at;
                if (
                  (reportTurn !== undefined && turn >= reportTurn) ||
                  foundTurn === turn
                ) {
                  marks.result ??= at;
                }
              }
              break;
            case "action.result": {
              const result = browserResultSchema.safeParse(event.data.result);
              if (result.success && marks.browserTask === undefined) {
                marks.browserTask = at;
                marks.status = result.data.output.status;
                marks.runId = result.data.output.runId;
                if (result.data.output.status === "found") foundTurn = turn;
              }
              break;
            }
            case "message.completed":
              // A report turn may answer in plain text instead of
              // `send_message`: the web chat shows it all the same.
              if (
                reportTurn !== undefined &&
                turn >= reportTurn &&
                !bookkeeping.test(event.data.message ?? "")
              ) {
                marks.result ??= at;
                marks.resultAsText ??= at;
              }
              break;
            case "session.waiting":
              // Done once the person read the result, or when the first
              // turn ended without an errand: Bro answered another way.
              if (marks.result !== undefined) done = true;
              if (marks.browserTask === undefined && turn === 0) {
                marks.noErrand = at;
                done = true;
              }
              break;
            default:
              break;
          }
          if (done) break;
        }
      } catch (error) {
        // An aborted read ends the loop; anything else is reopened.
        console.error(String(error));
        // oxlint-disable-next-line eslint/no-await-in-loop -- a pause before reopening
        await new Promise((wait) => setTimeout(wait, 2000));
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { marks, sends, sessionId: session.state.sessionId, text, tools };
}

for (let run = 0; run < runs; run += 1) {
  for (const [at, text] of texts.entries()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- errands go one after another: one browser per workspace
    const outcome = await errand(text);
    console.log(JSON.stringify({ run, ...outcome }));
    const last = run === runs - 1 && at === texts.length - 1;
    // oxlint-disable-next-line eslint/no-await-in-loop -- the gap between errands
    if (!last) await new Promise((wait) => setTimeout(wait, gapMs));
  }
}
