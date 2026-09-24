import { alertOwner, clearOwnerAlert } from "@agent/lib/owner-alert";

const alertKey = "browser-use-no-credits";
/** Every errand hits the same wall, so one reminder in a few hours is enough. */
const alertRepeatAfterMs = 6 * 60 * 60_000;

/**
 * What the coordinator tells the person when Browser Use refused to start or
 * continue a run with a 402. The cause may be the project's balance or the
 * key's spend cap, and the owner's alert may not have gone out, so the note
 * claims neither: it says the service is unavailable, which is all the person
 * needs. Nothing it tries on Browser Use again this turn will work.
 */
export const browserUseOutOfCreditsNote =
  "Nothing was started: the cloud browser service is unavailable right now (it refused new runs for billing reasons, which only the service owner can fix). Tell the user honestly in one short sentence that the browser service is temporarily unavailable, and offer what you can do without a browser (web_search, web_fetch) or to try again later. Do not call browser_task start or continue again in this turn and do not promise a time.";

/**
 * Browser Use answered 402: the project has no credits, or the key reached
 * its spend cap. Every errand stops until the owner tops it up, and until
 * now nobody told them — all errands stood still for hours. Never throws: the
 * person's answer must not depend on the alert going out.
 */
export async function reportBrowserUseOutOfCredits(cause: unknown) {
  console.error("[browser-use] out of credits", { cause });
  try {
    await alertOwner(
      alertKey,
      [
        "Browser Use ответил 402: на проекте кончились кредиты или ключ упёрся в лимит трат.",
        "Браузерные поручения не запускаются; людям Бро говорит, что сервис временно без баланса. Пополни кредиты в кабинете Browser Use.",
      ].join("\n"),
      { repeatAfterMs: alertRepeatAfterMs }
    );
  } catch (error) {
    console.warn("[browser-use] the owner could not be alerted", {
      cause: error,
    });
  }
}

/**
 * A run started, so the balance is back: the next time it runs out, the owner
 * hears about it at once rather than hours later.
 */
export async function browserUseCreditsRestored() {
  try {
    await clearOwnerAlert(alertKey);
  } catch (error) {
    console.warn("[browser-use] the credits alert could not be re-armed", {
      cause: error,
    });
  }
}
