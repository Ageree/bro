import { Client, type MessageStreamEvent } from "eve/client";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { benchEnv } from "../env/bench.ts";
import { registerApplicationModuleResolution } from "../lib/module-resolution.ts";
import { defaultCookieFile, readCookieHeader } from "./cookies.ts";
import { signedInSession } from "./sign-in.ts";

/**
 * How long a person waits for Bro's first message (18.10): sends `--text`
 * to one web conversation `--runs` times, `--gap-s` apart, in the same
 * session, so later runs read a warm cache as a long Telegram chat does,
 * and prints a JSON line per run with the milliseconds from the POST to
 * each turn boundary: the server's own `meta.at` (`at`) and the moment the
 * event reached this machine (`got`), and the POST's epoch milliseconds
 * (`started`) to find the turn in eve's journal. Reads nothing but the session it
 * opens; `--session` continues one. `--file` attaches a photo or PDF to
 * every run's message as the web composer sends it (`media.ts`).
 *
 *   node --experimental-strip-types scripts/bench/latency.ts \
 *     --cookie-file ~/.bro-bench/cookies.txt --runs 5 --text "привет, как дела?"
 */

const { values: flags } = parseArgs({
  options: {
    "cookie-file": { type: "string" },
    file: { multiple: true, type: "string" },
    "gap-s": { default: "20", type: "string" },
    host: { type: "string" },
    runs: { default: "3", type: "string" },
    session: { type: "string" },
    text: { multiple: true, type: "string" },
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

const files = (flags.file ?? []).map((path) => ({ path: resolve(path) }));
// The media helpers load application modules through the tsconfig aliases.
registerApplicationModuleResolution();
const { messageContent } = await import("./media.ts");

const texts = flags.text ?? ["привет! как дела?"];
const runs = Number(flags.runs);
const gapMs = Number(flags["gap-s"]) * 1000;
let session =
  flags.session === undefined
    ? undefined
    : client.sessions.attach(flags.session);

function label(event: MessageStreamEvent, step: number) {
  switch (event.type) {
    case "actions.requested":
      return `actions.requested:${event.data.actions
        .map((action) => ("toolName" in action ? action.toolName : action.kind))
        .join(",")}`;
    case "action.result":
      return `action.result:${event.data.result.kind}`;
    case "step.started":
      return `step.started:${String(step + 1)}`;
    case "step.completed":
      return `step.completed:${String(step)}`;
    case "action.input.appended":
    case "message.appended":
    case "reasoning.appended":
      return undefined;
    default:
      return event.type;
  }
}

const ends = new Set([
  "session.completed",
  "session.failed",
  "session.waiting",
]);

for (let run = 0; run < runs; run += 1) {
  const text = texts[run % texts.length] ?? "";
  // oxlint-disable-next-line eslint/no-await-in-loop -- read before the clock starts
  const message = await messageContent(text, files, []);
  const started = Date.now();
  let response;
  if (session === undefined) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the runs go one after another, in one session
    const opened = await client.sessions.create({ message });
    session = opened.session;
    response = opened.response;
  } else {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the runs go one after another, in one session
    response = await session.send(message);
  }
  const marks: { at: number; got: number; what: string }[] = [];
  let step = -1;
  // oxlint-disable-next-line eslint/no-await-in-loop -- one turn's events, in order
  for await (const event of response) {
    const what = label(event, step);
    if (event.type === "step.started") step += 1;
    if (what !== undefined) {
      marks.push({
        at: Date.parse(event.meta.at) - started,
        got: Date.now() - started,
        what,
      });
    }
    if (ends.has(event.type)) break;
  }
  console.log(
    JSON.stringify({ marks, run, sessionId: response.sessionId, started })
  );
  if (run < runs - 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the gap between runs
    await new Promise((done) => setTimeout(done, gapMs));
  }
}
