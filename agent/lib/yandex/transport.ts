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
import { afishaPricesDirect, afishaSearchDirect } from "./afisha/direct";
import { goOpenOperation } from "./go/open";
import { yandexDirectPilot } from "./pilot";
import {
  type JsonValue,
  type YandexOperation,
  isYandexHost,
  operationAnswerSchema,
} from "./operations";
import { statusOperation } from "./status";

/**
 * How a call to a Yandex service ended, in words the tool gives the model:
 * `ok` carries the operation's data and nothing else, and a failure names
 * what to do, never what the server wrote.
 */
export type YandexOutcome =
  | { readonly data: JsonValue; readonly kind: "ok" }
  | { readonly kind: "captcha" }
  | { readonly kind: "failed"; readonly reason: "answer" | "page" | "timeout" }
  | {
      /** Yandex ID's own word: its sign-in came up, or its page said so. */
      readonly byYandexId?: true;
      readonly kind: "signed_out";
    }
  | { readonly kind: "unavailable" };

/**
 * One call as it came back, before the transport makes a missing session of
 * the service's own (`no_session`) and calls again.
 */
type CallOutcome = YandexOutcome | { readonly kind: "no_session" };

/** Opening the tab includes waking a sandbox that is off. */
const openBudgetMs = 45_000;
/** The page's load and the call in it. */
const callBudgetMs = 35_000;
/**
 * A purchase reads the order again, sends it and reads its payment in one
 * call: cut short after sending, it loses the order's id (Afisha, 22.10).
 */
const purchaseBudgetMs = 55_000;

type Landing = "captcha" | "off_site" | "run" | "signed_out";

/**
 * Where the page ended up, before anything is run in it: Yandex's sign-in
 * means nobody is signed in, its check means a captcha, and a page that is
 * not Yandex's own (a redirect off the site) is never run in.
 */
function landing(url: string): Landing {
  const page = URL.parse(url);
  if (page === null || !isYandexHost(page.hostname)) return "off_site";
  if (/captcha/iu.test(page.hostname) || /captcha/iu.test(page.pathname)) {
    return "captcha";
  }
  if (
    page.hostname.startsWith("passport.") &&
    /^\/auth(\/|$)/u.test(page.pathname)
  ) {
    return "signed_out";
  }
  return "run";
}

/**
 * Run one operation in a tab of the workspace's own pool browser, which is
 * signed in to Yandex as the person: open the tab (waking the sandbox the
 * way a person's message does, for as long as a turn waits for one), go to
 * the operation's origin, call its fixed function there with the arguments
 * as data, check the answer against the operation's schema, close the tab.
 * The function's requests are the page's own, so the cookies and tokens
 * never leave the browser and the sandbox's exit address is the one the
 * service knows. Nothing here reads cookies or response headers.
 */
export async function runYandexOperation(
  workspaceId: string,
  operation: YandexOperation,
  args: JsonValue
): Promise<YandexOutcome> {
  const first = await runOperation(workspaceId, operation, args);
  if (first.kind !== "no_session") return first;
  // Go keeps its session in its own page's storage, made when that page
  // first starts: a browser that never opened Go has none, signed in to
  // Yandex or not. 23.10 a new person's taxi failed on it three times, and
  // Bro went to the site instead of signing them in to Yandex. Whether they
  // are signed in is Yandex ID's word: signed out, the caller leads them to
  // sign in; signed in, Go's page is opened once and the call made again.
  // The call answered before it sent anything, so a booking is not sent
  // twice.
  const signedIn = await runOperation(workspaceId, statusOperation, {});
  if (signedIn.kind !== "ok") return settled(signedIn);
  const opened = await runOperation(workspaceId, goOpenOperation, {});
  console.info("[yandex] go session", {
    opened: opened.kind,
    operation: operation.id,
    workspaceId,
  });
  if (opened.kind !== "ok") return settled(opened);
  return settled(await runOperation(workspaceId, operation, args));
}

/** A session still missing after all that is a call that failed. */
function settled(outcome: CallOutcome): YandexOutcome {
  return outcome.kind === "no_session"
    ? { kind: "failed", reason: "page" }
    : outcome;
}

async function runOperation(
  workspaceId: string,
  operation: YandexOperation,
  args: JsonValue
): Promise<CallOutcome> {
  const direct = await tryDirect(workspaceId, operation, args);
  if (direct !== undefined) return direct;
  if (!(await usesBrowserPool({ workspaceId }))) {
    return { kind: "unavailable" };
  }
  const first = await callInTab(workspaceId, operation, args);
  if (first.kind !== "unreachable") return first;
  // The page found no network through the browser's exit: 20.10 the owner's
  // sticky exit died, and every call failed on it until a message of theirs
  // happened to find its check stale. The exit is checked again at once and
  // moved when that fails, and the call is made again when nothing of it ran
  // or it only reads. A change that may have gone out is not sent twice, and
  // its answer does not wait for the check.
  const profileId = browserVmProfileId(workspaceId, 0);
  const again = !first.ran || operation.access === "read";
  if (!again) void renewBrowserVmExit(profileId);
  const renewed = again ? await renewBrowserVmExit(profileId) : null;
  console.warn("[yandex] the page did not reach the site", {
    operation: operation.id,
    ran: first.ran,
    renewed,
    workspaceId,
  });
  if (renewed !== true) return { kind: "failed", reason: "page" };
  const second = await callInTab(workspaceId, operation, args);
  return second.kind === "unreachable"
    ? { kind: "failed", reason: "page" }
    : second;
}

/** One call in a tab of its own; `unreachable` when the network failed it. */
async function callInTab(
  workspaceId: string,
  operation: YandexOperation,
  args: JsonValue
): Promise<
  CallOutcome | { readonly kind: "unreachable"; readonly ran: boolean }
> {
  const began = Date.now();
  const opening = openTab(workspaceId);
  let opened: Awaited<ReturnType<typeof within<Awaited<typeof opening>>>>;
  try {
    opened = await within(opening, openBudgetMs);
  } catch (error) {
    console.warn("[yandex] the tab could not be opened", {
      name: error instanceof Error ? error.name : "unknown",
      operation: operation.id,
    });
    return { kind: "unavailable" };
  }
  if (opened.timedOut) {
    // A tab that opens after the wait is closed all the same.
    void opening
      .then(async (late) => stopBrowserVmBrowser(late.id))
      .catch(() => undefined);
    return { kind: "failed", reason: "timeout" };
  }
  const tab = opened.value;
  const tabMs = Date.now() - began;
  try {
    const called = await within(
      callInPageOverCdp(tab.cdpUrl, {
        argument: args,
        fn: operation.run,
        loaded: operation.loaded,
        runOn: (url) =>
          landing(url) === "run" &&
          (operation.access === "read" ||
            URL.parse(url)?.origin === new URL(operation.origin).origin),
        url: operation.origin,
      }),
      operation.access === "purchase" ? purchaseBudgetMs : callBudgetMs
    );
    if (called.timedOut) return { kind: "failed", reason: "timeout" };
    const { value } = called;
    console.info("[yandex] call", {
      callMs: Date.now() - began - tabMs,
      operation: operation.id,
      tabMs,
      workspaceId,
    });
    if (!value.ran) {
      const where = landing(value.url);
      if (where === "signed_out")
        return { byYandexId: true, kind: "signed_out" };
      if (where === "captcha") return { kind: "captcha" };
      return { kind: "failed", reason: "page" };
    }
    const answer = operationAnswerSchema.safeParse(value.value);
    if (!answer.success) return { kind: "failed", reason: "answer" };
    if (answer.data.status === "signed_out") {
      // A service's own 401 may be its session alone, not Yandex ID's.
      return operation.service === statusOperation.service
        ? { byYandexId: true, kind: "signed_out" }
        : { kind: "signed_out" };
    }
    if (answer.data.status === "captcha") return { kind: "captcha" };
    if (answer.data.status === "no_session") return { kind: "no_session" };
    const data = operation.result.safeParse(answer.data.data);
    return data.success
      ? { data: data.data, kind: "ok" }
      : { kind: "failed", reason: "answer" };
  } catch (error) {
    if (error instanceof PageUnreachableError) {
      return { kind: "unreachable", ran: error.ran };
    }
    // The error may quote the page: only its fact is logged.
    console.warn("[yandex] the call failed", {
      name: error instanceof Error ? error.name : "unknown",
      operation: operation.id,
    });
    return { kind: "failed", reason: "page" };
  } finally {
    try {
      await stopBrowserVmBrowser(tab.id);
    } catch (error) {
      console.warn("[yandex] the tab could not be closed", {
        name: error instanceof Error ? error.name : "unknown",
        operation: operation.id,
      });
    }
  }
}

/** The public reads that need no sign-in, by operation, as the server asks them. */
const directReads = new Map([
  ["afisha.prices", afishaPricesDirect],
  ["afisha.search", afishaSearchDirect],
]);

/**
 * A public read that needs no sign-in is asked from the server itself, no
 * tab: about a second instead of five or more. Only for the workspaces in
 * YANDEX_DIRECT_WORKSPACES; a refusal of any kind falls through to the tab.
 */
async function tryDirect(
  workspaceId: string,
  operation: YandexOperation,
  args: JsonValue
): Promise<YandexOutcome | undefined> {
  const read = directReads.get(operation.id);
  if (read === undefined || !yandexDirectPilot({ workspaceId })) {
    return undefined;
  }
  const began = Date.now();
  const answer = await read(args);
  if (answer === undefined) return undefined;
  const data = operation.result.safeParse(answer);
  if (!data.success) {
    // The tab is asked instead, slower: an answer the schema refuses is a bug.
    console.warn("[yandex] direct answer refused by its schema", {
      issues: data.error.issues.slice(0, 3).map(({ path }) => path.join(".")),
      operation: operation.id,
    });
    return undefined;
  }
  console.info("[yandex] direct", {
    ms: Date.now() - began,
    operation: operation.id,
    workspaceId,
  });
  return { data: data.data, kind: "ok" };
}

/** The blank tab on the workspace's profile, its sandbox woken for it. */
async function openTab(workspaceId: string) {
  return createBrowserVmBrowser({
    // The generation is not read: the workspace is what the id names.
    profileId: browserVmProfileId(workspaceId, 0),
    wake: true,
  });
}
