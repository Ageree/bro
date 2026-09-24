import { alertOwner, clearOwnerAlert } from "@agent/lib/owner-alert";

const alertKey = "browser-use-no-credits";
/** Every errand hits the same wall, so one reminder in a few hours is enough. */
const alertRepeatAfterMs = 6 * 60 * 60_000;

/**
 * What the coordinator tells the person when Browser Use refused to start a
 * run for want of credits. Nothing it tries again this turn will start, and
 * the fix is the owner's, who has already been told.
 */
export const browserUseOutOfCreditsNote =
  "Nothing was started: the cloud browser service is out of credits right now, and the owner has already been notified to top it up. Tell the user honestly in one short sentence that the browser service is temporarily unavailable because its balance ran out, that the owner knows, and offer what you can do without a browser (web_search, web_fetch) or to try again later. Do not call browser_task start again in this turn and do not promise a time.";

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
