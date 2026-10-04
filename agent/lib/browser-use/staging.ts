/**
 * The words a run is told the errand is to be done with, which also mark a
 * composed run: its follow-ups carry the same rule, and a queued start or an
 * anti-bot retry of it is no search and keeps full mode (`stagesErrand`).
 */
export const stagingLead =
  "The person asked for this to be done — booked, bought, ordered or signed up for — not only found.";

/** Whether a composed run was told the errand is to be done. */
export function stagesErrand(task: string | undefined) {
  return task?.includes(stagingLead) === true;
}
