import { defineState } from "eve/context";
import type { ToolContext } from "eve/tools";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";
import { readCardOfRun } from "@db/services/cards";

const reportCard = defineState<{
  readonly ref: string;
  readonly runId: string;
} | null>("bro.card-report", () => null);

/** Binds a browser report to the card whose accepted event started its errand. */
export async function openCardReport(runId: string | undefined) {
  reportCard.update(() => null);
  if (!runId) return;
  const card = await readCardOfRun(runId);
  if (card) reportCard.update(() => ({ ref: card.ref, runId }));
}

/** The card this exact browser report belongs to; never a payment authorization. */
export function cardOfReport(
  caller: ToolContext["session"]["auth"]["current"]
) {
  try {
    const card = reportCard.get();
    return card && reportedBrowserRunId(caller) === card.runId
      ? card
      : undefined;
  } catch {
    return undefined;
  }
}
