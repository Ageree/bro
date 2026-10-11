import { z } from "zod";
import { openCdpConnection } from "@agent/lib/browser-use/cdp";
import { browserVmProfileId } from "@agent/lib/browser-vm/ids";
import {
  createBrowserVmBrowser,
  stopBrowserVmBrowser,
} from "@agent/lib/browser-vm/runs";
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
 * expression awaited in the page — and waits. The result goes to the PUT
 * URL, never to the job's log: it holds the person's data.
 */

const specSchema = z.union([
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

async function main() {
  const [specUrl, resultUrl] = process.argv.slice(2);
  if (!specUrl || !resultUrl) {
    throw new Error("Usage: yandex-probe.sh SPEC_GET_URL RESULT_PUT_URL");
  }
  const spec = specSchema.parse(await (await fetch(specUrl)).json());
  let result: unknown;
  if ("op" in spec) {
    const operation = findYandexOperation(spec.op);
    if (!operation) throw new Error(`No operation ${spec.op}.`);
    result = await runYandexOperation(spec.workspace, operation, spec.args);
  } else {
    result = await probePage(spec.workspace, spec);
  }
  const body = JSON.stringify(result);
  const put = await fetch(resultUrl, { body, method: "PUT" });
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
