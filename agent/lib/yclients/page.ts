import * as z from "zod";
import {
  PageUnreachableError,
  callInPageOverCdp,
} from "@agent/lib/browser-use/cdp";
import { within } from "@agent/lib/browser-use/deadline";
import { usesBrowserPool } from "@agent/lib/browser-vm/backend";
import { browserVmProfileId } from "@agent/lib/browser-vm/ids";
import {
  createBrowserVmBrowser,
  renewBrowserVmExit,
  stopBrowserVmBrowser,
} from "@agent/lib/browser-vm/runs";

/**
 * YClients' API asked from a tab of the person's own pool browser, the way
 * the salon's booking form asks it: from abroad and from a data centre its
 * WAF answers some calls with a 403 page (24.10: `book_times` and
 * `book_services` from the cloud session), through the sandbox's Russian
 * exit every call answered in 0.3–0.5 s. The tab opens YClients' own
 * `robots.txt`, so the calls are same-origin and no page script runs.
 */
const origin = "https://api.yclients.com";
const page = `${origin}/robots.txt`;

/** Opening the tab includes waking a sandbox that is off. */
const openBudgetMs = 45_000;
/** The page's load and the calls in it. */
const callBudgetMs = 30_000;

/**
 * The function the page runs, fixed by code: the requests come as data. A
 * request the network failed answers status 0 — it may have reached
 * YClients all the same.
 */
const run = `async function (a) {
  return Promise.all(a.requests.map(async (q) => {
    try {
      const headers = { accept: "application/vnd.yclients.v2+json", authorization: "Bearer " + a.token };
      if (q.body !== null) headers["content-type"] = "application/json";
      const r = await fetch(q.path, { method: q.method, headers, body: q.body === null ? undefined : q.body, credentials: "omit" });
      return { status: r.status, text: (await r.text()).slice(0, 2000000) };
    } catch (e) {
      return { status: 0, text: "" };
    }
  }));
}`;

/** One request as the page sends it: a path of YClients' API and a body. */
interface PageRequest {
  readonly body: string | null;
  readonly method: "GET" | "POST";
  readonly path: string;
}

const answersSchema = z.array(
  z.object({ status: z.number().int(), text: z.string() })
);

/** One request's answer: its HTTP status (0: no answer) and its body. */
export type PageAnswer = z.infer<typeof answersSchema>[number];

/**
 * The calls could not be made in the browser. `sent`: they may have gone
 * out, and a booking among them may exist.
 */
export class YclientsPageError extends Error {
  override readonly name = "YclientsPageError";

  constructor(
    readonly sent: boolean,
    message: string
  ) {
    super(message);
  }
}

type TabOutcome =
  | { readonly answers: PageAnswer[]; readonly kind: "answers" }
  | { readonly kind: "failed"; readonly reason: string; readonly sent: boolean }
  | { readonly kind: "unreachable"; readonly ran: boolean };

/**
 * Send the requests together from one tab of the workspace's pool browser
 * and answer each one's status and body, in order. A network the exit did
 * not carry has the exit checked again and the calls made once more, unless
 * a change among them may have gone out (`writes`).
 */
export async function sendInPage(
  workspaceId: string,
  token: string,
  requests: readonly PageRequest[],
  writes: boolean
) {
  // Nothing has gone out until the tab runs the calls.
  const pool = await usesBrowserPool({ workspaceId }).catch(() => false);
  if (!pool) throw new YclientsPageError(false, "no pool browser");
  const first = await inTab(workspaceId, token, requests);
  if (first.kind === "answers") return first.answers;
  if (first.kind === "failed") {
    throw new YclientsPageError(first.sent, first.reason);
  }
  if (first.ran && writes) {
    throw new YclientsPageError(true, "the network failed the calls");
  }
  const renewed = await renewBrowserVmExit(
    browserVmProfileId(workspaceId, 0)
  ).catch(() => false);
  console.warn("[yclients] the page did not reach YClients", {
    ran: first.ran,
    renewed,
    workspaceId,
  });
  if (!renewed) {
    throw new YclientsPageError(false, "the exit did not carry the page");
  }
  const second = await inTab(workspaceId, token, requests);
  if (second.kind === "answers") return second.answers;
  throw new YclientsPageError(
    second.kind === "failed" ? second.sent : second.ran && writes,
    second.kind === "failed" ? second.reason : "the network failed the calls"
  );
}

async function inTab(
  workspaceId: string,
  token: string,
  requests: readonly PageRequest[]
): Promise<TabOutcome> {
  const began = Date.now();
  const opening = createBrowserVmBrowser({
    // The generation is not read: the workspace is what the id names.
    profileId: browserVmProfileId(workspaceId, 0),
    wake: true,
  });
  let opened: Awaited<ReturnType<typeof within<Awaited<typeof opening>>>>;
  try {
    opened = await within(opening, openBudgetMs);
  } catch (error) {
    return {
      kind: "failed",
      reason: `tab: ${error instanceof Error ? error.name : "unknown"}`,
      sent: false,
    };
  }
  if (opened.timedOut) {
    // A tab that opens after the wait is closed all the same.
    void opening
      .then(async (late) => stopBrowserVmBrowser(late.id))
      .catch(() => undefined);
    return { kind: "failed", reason: "tab: timeout", sent: false };
  }
  const tab = opened.value;
  const tabMs = Date.now() - began;
  try {
    const called = await within(
      callInPageOverCdp(tab.cdpUrl, {
        argument: {
          requests: requests.map((one) => ({
            body: one.body,
            method: one.method,
            path: one.path,
          })),
          token,
        },
        fn: run,
        loaded: "interactive",
        runOn: (url) => URL.parse(url)?.origin === origin,
        url: page,
      }),
      callBudgetMs
    );
    if (called.timedOut) {
      return { kind: "failed", reason: "call: timeout", sent: true };
    }
    const { value } = called;
    if (!value.ran) {
      return { kind: "failed", reason: "landed off YClients", sent: false };
    }
    const answers = answersSchema.safeParse(value.value);
    if (!answers.success || answers.data.length !== requests.length) {
      return { kind: "failed", reason: "answer", sent: true };
    }
    // Not one call found a network: the exit did not carry the page's
    // requests (it may have served robots.txt from the cache).
    if (answers.data.every((answer) => answer.status === 0)) {
      return { kind: "unreachable", ran: true };
    }
    console.info("[yclients] page", {
      callMs: Date.now() - began - tabMs,
      requests: requests.length,
      tabMs,
      workspaceId,
    });
    return { answers: answers.data, kind: "answers" };
  } catch (error) {
    if (error instanceof PageUnreachableError) {
      return { kind: "unreachable", ran: error.ran };
    }
    // The error may quote the page: only its fact is kept.
    return {
      kind: "failed",
      reason: `call: ${error instanceof Error ? error.name : "unknown"}`,
      sent: true,
    };
  } finally {
    try {
      await stopBrowserVmBrowser(tab.id);
    } catch (error) {
      console.warn("[yclients] the tab could not be closed", {
        name: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}
