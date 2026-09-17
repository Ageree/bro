// A stand-in for Browser Use Cloud v4, for staging.
//
//   node --experimental-strip-types scripts/fake-browser-use.ts --port=8787
//   # then, on the staging deployment (both eve and Convex):
//   BROWSER_USE_BASE_URL=https://<where this runs>/api/v4
//
// Why a separate service rather than a "pretend" branch inside the client: a
// flag that leaked into production would silently make Bro behave as if it had
// bought things. A wrong base URL is a deliberate act, visible in
// `convex env list` and in every log line, and it cannot happen by forgetting
// to unset something.
//
// What it is for: shopping, login and payment errands are the slowest and most
// expensive thing to test by hand, and the least deterministic — a real run
// depends on a real shop being up and a real Cloud agent behaving. The parts
// worth testing on our side are the glue: does a «НУЖНО» outcome reach the
// human as a live-view link, does a `done` wakeup start the queued errand,
// does an order get recorded exactly once. All of that is driven by the run's
// final labelled block, which is what this serves.
//
// The outcome is chosen from the task text, so a scenario steers it by what
// the human asks for rather than by reconfiguring the server.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

type Outcome = { status: string; result: string };

/** A finished purchase, with the labelled block `parseCloudOutcome` reads. */
const BOUGHT: Outcome = {
  status: "completed",
  result: [
    "СДЕЛАНО: заказал",
    "ЗАКАЗ: 4815162342",
    "СУММА: 1290 ₽",
    "КОГДА: завтра до 18:00",
    "НУЖНО: нет",
    "ДЕТАЛИ: пункт выдачи на Ленина 5",
  ].join("\n"),
};

/** Parked on the human: a bank confirmation the agent cannot resolve itself. */
const NEEDS_3DS: Outcome = {
  status: "completed",
  result: [
    "СДЕЛАНО: нет",
    "НУЖНО: 3ds",
    "ДЕТАЛИ: банк просит подтвердить оплату",
  ].join("\n"),
};

const NEEDS_CODE: Outcome = {
  status: "completed",
  result: ["СДЕЛАНО: нет", "НУЖНО: sms_code", "ДЕТАЛИ: код из смс"].join("\n"),
};

const FAILED: Outcome = {
  status: "failed",
  result: ["СДЕЛАНО: нет", "НУЖНО: нет", "ДЕТАЛИ: сайт не открылся"].join("\n"),
};

/**
 * Which ending this task gets. Keyed off the task the model wrote, so a
 * scenario picks the branch by asking for it in Russian — the same way a human
 * would — instead of the suite reaching behind the model to configure a mock.
 */
function outcomeFor(task: string): Outcome {
  const text = humanErrand(task).toLowerCase();
  if (/3ds|3-d|подтверд|банк/.test(text)) return NEEDS_3DS;
  if (/код из смс|смс-код|sms/.test(text)) return NEEDS_CODE;
  if (/сломан|не работает|ошибк/.test(text)) return FAILED;
  return BOUGHT;
}

/**
 * Just the errand, without the scaffold `scaffoldTask` wraps around it.
 *
 * That scaffold is the «НУЖНО» protocol itself, so it names `3ds` and `sms`
 * in its own instructions. Matching against the whole task made every errand
 * come back parked on the bank — the fake was reading Bro's instructions to
 * the Cloud agent as if they were the human's request.
 *
 * The extraction is structural — the line after the `[bro-errand]` mark, minus
 * whatever label it carries — rather than a search for that label by name.
 * It was `Задача:` and became `ЦЕЛЬ:` in #108, and a fake keyed to the word
 * did not fail: it quietly matched nothing and reported every errand as
 * bought. Product copy churns; the shape does not.
 */
export function humanErrand(task: string): string {
  const lines = task.split("\n").map((l) => l.trim());
  const mark = lines.findIndex((l) => l.startsWith(ERRAND_MARK));
  const line =
    (mark >= 0 ? lines.slice(mark + 1).find(Boolean) : undefined) ??
    lines.find(Boolean) ??
    task;
  // `ЦЕЛЬ: купи молоко` → `купи молоко`; an unlabelled line is left alone.
  const labelled = /^[\p{Lu}][\p{Lu}\s]*:\s*(.*)$/u.exec(line);
  return labelled?.[1] ?? line;
}

/** The marker `scaffoldTask` opens an errand with. */
const ERRAND_MARK = "[bro-errand]";

type Run = {
  id: string;
  sessionId: string;
  task: string;
  startedAt: number;
  cancelled: boolean;
};

const runs = new Map<string, Run>();
const port = Number(
  process.argv.find((a) => a.startsWith("--port="))?.slice("--port=".length) ??
    process.env.PORT ??
    8787,
);
/**
 * How long a run "takes". Not zero: the progress notes, the poll loop and the
 * busy/queue branches only exist because a real run lasts minutes, and a fake
 * that finished instantly would skip every one of them.
 */
const runMs = Number(
  process.argv.find((a) => a.startsWith("--run-ms="))?.slice("--run-ms=".length) ??
    process.env.FAKE_BROWSER_RUN_MS ??
    8000,
);

const liveUrl = (sessionId: string) =>
  `https://fake-live.browser-use.com/${sessionId}`;

function finished(run: Run): boolean {
  return Date.now() - run.startedAt >= runMs;
}

function statusOf(run: Run): string {
  if (run.cancelled) return "cancelled";
  if (!finished(run)) return "running";
  return outcomeFor(run.task).status;
}

function runBody(run: Run): Record<string, unknown> {
  const status = statusOf(run);
  return {
    id: run.id,
    sessionId: run.sessionId,
    status,
    liveUrl: liveUrl(run.sessionId),
    ...(status === "running" ? {} : { result: outcomeFor(run.task).result }),
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    // Accept the real client's path prefix so BROWSER_USE_BASE_URL can be set
    // to `<host>/api/v4`, exactly like the real one.
    const path = url.pathname.replace(/^\/api\/v4/, "");
    const body = req.method === "GET" ? {} : await readBody(req);
    console.log(`[fake-browser-use] ${req.method} ${path}`);

    if (path === "/profiles" && req.method === "POST") {
      return json(res, { id: randomUUID() });
    }
    if (path.startsWith("/profiles/") && req.method === "GET") {
      return json(res, { id: path.slice("/profiles/".length), cookieDomains: [] });
    }

    if (path === "/runs" && req.method === "POST") {
      const id = randomUUID();
      const run: Run = {
        id,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : randomUUID(),
        task: typeof body.task === "string" ? body.task : "",
        startedAt: Date.now(),
        cancelled: false,
      };
      runs.set(id, run);
      return json(res, runBody(run));
    }

    const runMatch = /^\/runs\/([^/]+)(\/.*)?$/.exec(path);
    if (runMatch) {
      const run = runs.get(runMatch[1]!);
      if (!run) return json(res, { detail: "not found" }, 404);
      const tail = runMatch[2] ?? "";
      if (tail === "/cancel") {
        run.cancelled = true;
        return json(res, { ok: true });
      }
      if (tail === "/status") return json(res, { status: statusOf(run) });
      if (tail.startsWith("/events")) {
        return json(res, {
          items: [
            { type: "browser.ready", liveUrl: liveUrl(run.sessionId) },
            { type: "page.navigated", url: "https://www.wildberries.ru/" },
          ],
        });
      }
      return json(res, runBody(run));
    }

    if (path === "/browsers" && req.method === "GET") {
      return json(res, {
        items: [...runs.values()].map((run) => ({
          id: `browser-${run.sessionId}`,
          sessionId: run.sessionId,
          liveUrl: liveUrl(run.sessionId),
        })),
      });
    }
    if (path.startsWith("/browsers/")) return json(res, { ok: true });

    const sessionMatch = /^\/sessions\/([^/]+)(\/.*)?$/.exec(path);
    if (sessionMatch) {
      const sessionId = sessionMatch[1]!;
      if ((sessionMatch[2] ?? "") === "/queue") {
        // An injected mid-run message restarts the clock, the way a real
        // session picks the errand back up.
        for (const run of runs.values()) {
          if (run.sessionId === sessionId) run.startedAt = Date.now();
        }
        return json(res, { id: 1, sessionId, status: "queued", mode: "queued" });
      }
      return json(res, { id: sessionId, liveUrl: liveUrl(sessionId) });
    }

    json(res, { detail: `fake-browser-use has no ${path}` }, 404);
  })();
});

// Only when run as a program. Importing this module — which the check does, to
// assert the errand extraction directly against a real `scaffoldTask` output —
// must not open a socket, or the importing process never exits.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

// `--port=0` picks a free one, which is how the check starts it without
// racing another test for a fixed port — hence reporting the bound address
// rather than the requested one.
if (invokedDirectly) server.listen(port, () => {
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  console.log(`[fake-browser-use] listening on :${bound}, runs take ${runMs}ms`);
  console.log(`[fake-browser-use] set BROWSER_USE_BASE_URL=http://<host>:${bound}/api/v4`);
});
