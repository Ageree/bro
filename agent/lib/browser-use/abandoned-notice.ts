import {
  markBrowserRunNoticeSent,
  takeAbandonedBrowserRunReports,
} from "@db/services/browser-runs";
import type { BrowserRunDelivery } from "@agent/lib/browser-use/completion";
import { sendCodeNotice } from "@agent/lib/delivery/code-notice";

const titleLength = 60;

type AbandonedRun = Awaited<
  ReturnType<typeof takeAbandonedBrowserRunReports>
>[number];

/** What the errand is called to the person: its site, else its first words. */
function errandTitle(run: Pick<AbandonedRun, "site" | "task">) {
  const host = run.site ? URL.parse(run.site)?.hostname : undefined;
  if (host) return host.replace(/^www\./, "");
  const task = run.task.replaceAll(/\s+/g, " ").trim();
  return task.length > titleLength ? `${task.slice(0, titleLength)}…` : task;
}

export function abandonedReportNotice(
  run: Pick<AbandonedRun, "site" | "task">
) {
  const title = errandTitle(run);
  return `Поручение «${title}» закончено, но итог не дошёл. Спросите меня «что там с ${title}», и я расскажу.`;
}

/**
 * Tell the people whose browser errand finished but whose report ran out of
 * delivery attempts, without the model: the report turn is what kept failing.
 * A notice that fails is taken again later, and only a sent one takes the run
 * off the owner's overdue watch.
 */
export async function noticeAbandonedBrowserRunReports(
  delivery: Pick<BrowserRunDelivery, "attachSession">,
  now = new Date()
) {
  const runs = await takeAbandonedBrowserRunReports(now);
  await Promise.all(
    runs.map(async (run) => {
      try {
        await sendCodeNotice(
          delivery,
          {
            conversationChannel: run.conversationChannel,
            conversationId: run.conversationId,
            workspaceId: run.workspaceId,
            userId: run.createdByUserId,
            about: { browserRunId: run.id },
          },
          abandonedReportNotice(run)
        );
        await markBrowserRunNoticeSent(run.id, now);
        console.warn("[browser-use] undelivered report given up", {
          channel: run.conversationChannel,
          runId: run.id,
        });
      } catch (error) {
        // Taken again after a while: the person has not been told.
        console.warn("[browser-use] undelivered report notice failed", {
          cause: error,
          channel: run.conversationChannel,
          runId: run.id,
        });
      }
    })
  );
}
