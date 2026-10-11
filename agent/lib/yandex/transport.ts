import { callInPageOverCdp } from "@agent/lib/browser-use/cdp";
import { within } from "@agent/lib/browser-use/deadline";
import { usesBrowserPool } from "@agent/lib/browser-vm/backend";
import { browserVmProfileId } from "@agent/lib/browser-vm/ids";
import {
  createBrowserVmBrowser,
  stopBrowserVmBrowser,
} from "@agent/lib/browser-vm/runs";
import {
  type JsonValue,
  type YandexOperation,
  isYandexHost,
  operationAnswerSchema,
} from "./operations";

/**
 * How a call to a Yandex service ended, in words the tool gives the model:
 * `ok` carries the operation's data and nothing else, and a failure names
 * what to do, never what the server wrote.
 */
export type YandexOutcome =
  | { readonly data: JsonValue; readonly kind: "ok" }
  | { readonly kind: "captcha" }
  | { readonly kind: "failed"; readonly reason: "answer" | "page" | "timeout" }
  | { readonly kind: "signed_out" }
  | { readonly kind: "unavailable" };

/** Opening the tab includes waking a sandbox that is off. */
const openBudgetMs = 45_000;
/** The page's load and the call in it. */
const callBudgetMs = 35_000;

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
  if (!(await usesBrowserPool({ workspaceId }))) {
    return { kind: "unavailable" };
  }
  const began = Date.now();
  const opening = openTab(workspaceId);
  let opened: Awaited<ReturnType<typeof within<Awaited<typeof opening>>>>;
  try {
    opened = await within(opening, openBudgetMs);
  } catch (error) {
    console.warn("[yandex] the tab could not be opened", {
      cause: error,
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
          (operation.access !== "purchase" ||
            URL.parse(url)?.origin === new URL(operation.origin).origin),
        url: operation.origin,
      }),
      callBudgetMs
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
      if (where === "signed_out") return { kind: "signed_out" };
      if (where === "captcha") return { kind: "captcha" };
      return { kind: "failed", reason: "page" };
    }
    const answer = operationAnswerSchema.safeParse(value.value);
    if (!answer.success) return { kind: "failed", reason: "answer" };
    if (answer.data.status === "signed_out") return { kind: "signed_out" };
    if (answer.data.status === "captcha") return { kind: "captcha" };
    const data = operation.result.safeParse(answer.data.data);
    return data.success
      ? { data: data.data, kind: "ok" }
      : { kind: "failed", reason: "answer" };
  } catch (error) {
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
      console.warn("[yandex] the tab could not be closed", { cause: error });
    }
  }
}

/** The blank tab on the workspace's profile, its sandbox woken for it. */
async function openTab(workspaceId: string) {
  return createBrowserVmBrowser({
    // The generation is not read: the workspace is what the id names.
    profileId: browserVmProfileId(workspaceId, 0),
    wake: true,
  });
}
