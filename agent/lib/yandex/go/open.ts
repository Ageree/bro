import { z } from "zod";
import { defineYandexOperation } from "../operations";
import { goStartPage, goStoredUserSource } from "./session";

/**
 * Go's start page opened once in a browser where Go has no session yet: the
 * page makes it itself as it starts (its user id in IndexedDB, which every Go
 * operation reads), and this waits for it. Nothing is ordered or changed.
 * 23.10 a fresh Chromium profile had it 2.5 s after the page loaded, and the
 * owner's browser before the page finished. Not one of the tool's
 * operations: only the transport opens Go (`transport.ts`).
 */
export const goOpenOperation = defineYandexOperation({
  about: "Open Yandex Go's page once, so it makes its own session.",
  access: "read",
  args: z.object({}),
  id: "go.open",
  origin: goStartPage,
  result: z.object({ opened: z.literal(true) }),
  // The store is never deleted here: Go's own page is making it.
  run: `async function () {${goStoredUserSource}
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await goStoredUser(false)) return { status: "ok", data: { opened: true } };
    await new Promise((done) => setTimeout(done, 500));
  }
  return { status: "no_session" };
}`,
  service: "go",
});
