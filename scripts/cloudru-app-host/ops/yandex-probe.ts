import { z } from "zod";
import { openCdpConnection } from "@agent/lib/browser-use/cdp";
import { browserVmProfileId } from "@agent/lib/browser-vm/ids";
import {
  createBrowserVmBrowser,
  stopBrowserVmBrowser,
} from "@agent/lib/browser-vm/runs";
import { afishaSearchRequest } from "@agent/lib/yandex/afisha/direct";
import { isYandexHost } from "@agent/lib/yandex/operations";
import { findYandexOperation } from "@agent/lib/yandex/registry";
import { runYandexOperation } from "@agent/lib/yandex/transport";

/**
 * An operator's look at a Yandex service from the person's own pool browser,
 * for working out a service's API and checking an operation live:
 *
 *   host.py ops NAME yandex-probe.sh s3get:<spec key> s3put:<result key>
 *
 * The spec is JSON in Object Storage (an ops argument cannot hold it):
 * `{workspace, op, args}` runs a registered operation as the tool does;
 * `{workspace, page, steps, waitMs}` opens a Yandex page with every fetch and
 * XHR of the page recorded (method, URL, bodies), runs each step — an
 * expression awaited in the page — and waits; `{direct: "afisha.search",
 * args, times, pauseMs}` sends Afisha's search from this server with no
 * browser, as YANDEX_DIRECT does, and keeps of each answer only its status,
 * time, type and the number of events. The result goes to the PUT URL,
 * never to the job's log: it holds the person's data.
 */

const specSchema = z.union([
  z.strictObject({
    args: z.strictObject({
      city: z.string().min(1).max(50).default("moscow"),
      limit: z.number().int().min(1).max(10).default(10),
      query: z.string().min(1).max(200),
    }),
    direct: z.literal("afisha.search"),
    pauseMs: z.number().int().min(0).max(60_000).default(3000),
    times: z.number().int().min(1).max(20).default(5),
  }),
  z.strictObject({
    args: z.json().default({}),
    op: z.string().min(1),
    workspace: z.string().min(1),
  }),
  z.strictObject({
    page: z.url(),
    steps: z.array(z.string()).default([]),
    waitMs: z.number().int().min(0).max(60_000).default(4000),
    workspace: z.string().min(1),
  }),
]);

/** Records the page's requests from its first script on. */
const recorder = String.raw`(() => {
  const log = (window.__probe = []);
  const cut = (text) => (typeof text === "string" ? text.slice(0, 50000) : null);
  const native = window.fetch;
  window.fetch = async (input, init) => {
    const entry = { method: init?.method ?? input?.method ?? "GET", url: String(input?.url ?? input), request: cut(init?.body) };
    log.push(entry);
    const response = await native(input, init);
    entry.status = response.status;
    response.clone().text().then((body) => { entry.response = cut(body); }, () => {});
    return response;
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__probe = { method, url: String(url) };
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const entry = { ...this.__probe, request: cut(body) };
    log.push(entry);
    this.addEventListener("loadend", () => {
      entry.status = this.status;
      entry.response = cut(typeof this.response === "string" ? this.response : this.responseText);
    });
    return send.apply(this, arguments);
  };
})()`;

const sleep = async (ms: number) =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

async function evaluate(
  connection: Awaited<ReturnType<typeof openCdpConnection>>,
  expression: string
) {
  const reply = await connection.call("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  return reply;
}

async function probePage(
  workspace: string,
  spec: { page: string; steps: string[]; waitMs: number }
) {
  if (!isYandexHost(new URL(spec.page).hostname)) {
    throw new Error("Only Yandex pages are probed.");
  }
  const tab = await createBrowserVmBrowser({
    profileId: browserVmProfileId(workspace, 0),
    wake: true,
  });
  try {
    const connection = await openCdpConnection(tab.cdpUrl);
    try {
      await connection.call("Page.enable", {});
      await connection.call("Page.addScriptToEvaluateOnNewDocument", {
        source: recorder,
      });
      await connection.call("Page.navigate", { url: spec.page });
      await sleep(6000);
      // One after another: a step may click what the one before opened.
      const steps = await spec.steps.reduce(
        async (done, step) => [
          ...(await done),
          await evaluate(connection, step),
        ],
        Promise.resolve<Awaited<ReturnType<typeof evaluate>>[]>([])
      );
      await sleep(spec.waitMs);
      const landed = await evaluate(connection, "location.href");
      const requests = await evaluate(connection, "window.__probe ?? []");
      return { landed, requests, steps };
    } finally {
      connection.close();
    }
  } finally {
    await stopBrowserVmBrowser(tab.id);
  }
}

const afishaAnswerSchema = z.object({
  data: z.object({
    search: z.object({
      groups: z.array(z.object({ documents: z.array(z.unknown()) })),
    }),
  }),
});

/** One direct request: its status, time and shape, never its body. */
async function probeDirectOnce(args: {
  city: string;
  limit: number;
  query: string;
}) {
  const began = Date.now();
  try {
    const response = await afishaSearchRequest(args);
    const type = response.headers.get("content-type");
    const text = await response.text();
    const ms = Date.now() - began;
    let events: number | null = null;
    try {
      const answer = afishaAnswerSchema.safeParse(JSON.parse(text));
      if (answer.success) {
        events = answer.data.data.search.groups.reduce(
          (sum, group) => sum + group.documents.length,
          0
        );
      }
    } catch {
      events = null;
    }
    return { bytes: text.length, events, ms, status: response.status, type };
  } catch (error) {
    return {
      error: error instanceof Error ? error.name : "unknown",
      ms: Date.now() - began,
    };
  }
}

async function probeDirect(spec: {
  args: { city: string; limit: number; query: string };
  pauseMs: number;
  times: number;
}) {
  // One after another: the pause between them is part of the probe.
  const answers = await Array.from({ length: spec.times }).reduce(
    async (done: Promise<object[]>, _, index) => {
      const before = await done;
      if (index > 0) await sleep(spec.pauseMs);
      return [
        ...before,
        {
          at: new Date().toISOString(),
          ...(await probeDirectOnce(spec.args)),
        },
      ];
    },
    Promise.resolve([])
  );
  return { answers };
}

/**
 * A request to Object Storage, tried three times: from the VM a connection
 * to it now and then times out before it opens (ETIMEDOUT in Node's
 * connection to several addresses), and one such loses the whole probe.
 */
async function storageFetch(url: string, init?: RequestInit) {
  const attempt = async (left: number): Promise<Response> => {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (left <= 1) throw error;
      await sleep(1000);
      return attempt(left - 1);
    }
  };
  return attempt(3);
}

async function main() {
  const [specUrl, resultUrl] = process.argv.slice(2);
  if (!specUrl || !resultUrl) {
    throw new Error("Usage: yandex-probe.sh SPEC_GET_URL RESULT_PUT_URL");
  }
  const spec = specSchema.parse(await (await storageFetch(specUrl)).json());
  let result: unknown;
  if ("direct" in spec) {
    result = await probeDirect(spec);
  } else if ("op" in spec) {
    const operation = findYandexOperation(spec.op);
    if (!operation) throw new Error(`No operation ${spec.op}.`);
    result = await runYandexOperation(spec.workspace, operation, spec.args);
  } else {
    result = await probePage(spec.workspace, spec);
  }
  const body = JSON.stringify(result);
  const put = await storageFetch(resultUrl, { body, method: "PUT" });
  console.log(
    JSON.stringify({ bytes: body.length, stored: put.ok, status: put.status })
  );
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  // The pool's database pool would keep the process alive.
  process.exit();
}
