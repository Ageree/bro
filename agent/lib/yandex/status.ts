import { z } from "zod";
import { defineYandexOperation } from "./operations";

/**
 * Whether the browser is signed in to Yandex ID, and whether a request from
 * its page goes through. Nothing of the account comes back: no login, no
 * name, only yes or no. A browser that is not signed in is sent to the
 * sign-in on the way, which the transport reports as `signed_out` before
 * this function runs.
 */
export const statusOperation = defineYandexOperation({
  about: "Whether Bro's browser is signed in to Yandex ID. Takes no arguments.",
  access: "read",
  args: z.object({}),
  id: "status",
  loaded: "interactive",
  origin: "https://id.yandex.ru/",
  result: z.object({ requestWorks: z.boolean(), signedIn: z.literal(true) }),
  // A request of the page's own to its own origin: the chain from the tab to
  // a call with the browser's cookies, end to end. Other services are not
  // asked from here: a page's script may reach only its own origin (the
  // sign-in page's CSP closes the rest), so each service is reached by its
  // own operations on its own page.
  run: `async function () {
  let requestWorks = false;
  try {
    await fetch("/", { method: "HEAD", credentials: "include", cache: "no-store" });
    requestWorks = true;
  } catch (error) {
    requestWorks = false;
  }
  return { status: "ok", data: { signedIn: true, requestWorks } };
}`,
  service: "yandex-id",
});
