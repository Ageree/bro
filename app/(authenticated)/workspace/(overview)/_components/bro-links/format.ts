import type { BroProposal } from "@shared/bro-to-bro/contract";

/** A moment in the person's own time zone: «сб, 25 октября, 19:00». */
export function broMoment(value: Date | string, timeZone: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "long",
    timeZone,
    weekday: "short",
  }).format(new Date(value));
}

/**
 * When a proposal is, in the person's time zone: its start, and its end as
 * a time alone when it ends the same day.
 */
function broProposalTime(proposal: BroProposal, timeZone: string) {
  if (proposal.start === undefined) return null;
  const start = broMoment(proposal.start, timeZone);
  if (proposal.end === undefined) return start;
  const day = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeZone,
  });
  const sameDay =
    day.format(new Date(proposal.start)) === day.format(new Date(proposal.end));
  const end = sameDay
    ? new Intl.DateTimeFormat("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone,
      }).format(new Date(proposal.end))
    : broMoment(proposal.end, timeZone);
  return `${start} – ${end}`;
}

/**
 * A proposal as one line of the journal: what it is, when, where, and —
 * for an agreement of the second version — its sum and its points.
 */
export function broProposalLine(proposal: BroProposal, timeZone: string) {
  return [
    `Предложение: ${proposal.summary}`,
    broProposalTime(proposal, timeZone),
    proposal.place ?? null,
    proposal.amountRub === undefined
      ? null
      : `${proposal.amountRub.toLocaleString("ru-RU")} ₽`,
    proposal.items?.length ? proposal.items.join("; ") : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
