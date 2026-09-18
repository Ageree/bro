/**
 * The proactive scan, end to end: budget → data → candidates → prompt.
 *
 * Everything that decides anything lives in `convex/lib/instinctPolicy.ts`
 * (pure, tested offline by `scripts/instinct-check.ts`). This file only fetches
 * the facts that policy judges, and it fetches them through paths that already
 * exist — the Supermemory archive the hourly `/internal/memory-sync` cron fills
 * (`searchArchive`), the open-job snapshot every wake path already reads
 * (`jobWakeRows`), and the recorded orders (`listOrders`). No new data access,
 * no new dependency.
 *
 * Order matters: the budget is checked BEFORE any of that runs. A scan during
 * quiet hours, over the daily cap, or while the person is mid-conversation can
 * never end in a message, so it must not cost a Supermemory round trip or a
 * model turn either.
 */

import { searchArchive } from "./archive.ts";
import { ARCHIVE_RECALL_TIMEOUT_MS, type ArchiveHit } from "./archive-policy.ts";
import {
  instinctState,
  jobWakeRows,
  listOrders,
  noteInstinctSpoken,
} from "./convex.ts";
import {
  humanActive,
  instinctAllowed,
  instinctWakePrompt,
  selectCandidates,
  type InstinctCandidate,
} from "../../convex/lib/instinctPolicy.ts";

const HOUR = 60 * 60_000;

/** Hits per archive half. Small on purpose: this is a scan, not a search. */
const ARCHIVE_HITS = 5;

/**
 * One fixed query per half, in Russian, because the archive is Russian mail and
 * Russian calendar entries. These are semantic searches, not filters — the
 * policy is what decides whether a hit is worth a message.
 */
const CALENDAR_QUERY = "ближайшая встреча, событие календаря сегодня";
const MAIL_QUERY = "письмо, где от меня чего-то ждут: подтвердить, оплатить, срок";

export type InstinctScan =
  | { speak: false; reason: string }
  | { speak: true; prompt: string; sourceIds: string[] };

function trimLine(text: string, max = 200): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}

/** ISO date from an archive document's metadata, or null. */
function hitAt(hit: ArchiveHit): number | null {
  if (!hit.date) return null;
  const at = Date.parse(hit.date);
  return Number.isFinite(at) ? at : null;
}

/** Calendar hits carry the event start in `metadata.date` (see archive-policy). */
export function calendarCandidates(
  hits: readonly ArchiveHit[],
  now: number,
): InstinctCandidate[] {
  const out: InstinctCandidate[] = [];
  for (const hit of hits) {
    if (hit.app !== "calendar") continue;
    const at = hitAt(hit);
    if (at === null) continue;
    // An event that already started cannot be helped by a heads-up; the policy
    // would drop it anyway, this just keeps the list short.
    if (at <= now) continue;
    out.push({
      kind: "calendar_soon",
      summary: trimLine(
        `встреча «${hit.title}» в ${new Date(at).toISOString()}: ${hit.content}`,
      ),
      at,
      // Same id the sync writes as customId, so one event is one thing across
      // scans even when the search returns it with different wording.
      sourceId: `gcal:${hit.title}:${at}`,
    });
  }
  return out;
}

export function mailCandidates(
  hits: readonly ArchiveHit[],
  now: number,
): InstinctCandidate[] {
  const out: InstinctCandidate[] = [];
  for (const hit of hits) {
    if (hit.app !== "gmail" && hit.app !== "inkbox") continue;
    const at = hitAt(hit);
    // A letter older than two days is not news, whatever it says.
    if (at !== null && now - at > 48 * HOUR) continue;
    out.push({
      kind: "mail_actionable",
      summary: trimLine(`письмо «${hit.title}»: ${hit.content}`),
      ...(at !== null ? { at } : {}),
      sourceId: `mail:${hit.title}:${at ?? 0}`,
    });
  }
  return out;
}

export function errandCandidates(
  jobs: readonly { id: string; goal: string; note?: string; waitingSince?: number }[],
): InstinctCandidate[] {
  const out: InstinctCandidate[] = [];
  for (const job of jobs) {
    if (job.waitingSince === undefined) continue;
    out.push({
      kind: "errand_stalled",
      summary: trimLine(
        `поручение «${job.goal}» висит без движения${job.note ? `: ${job.note}` : ""}`,
      ),
      at: job.waitingSince,
      sourceId: `job:${job.id}`,
    });
  }
  return out;
}

export function orderCandidates(
  orders: readonly {
    _id: string;
    title: string;
    status: string;
    merchant: string;
    createdAt?: number;
  }[],
  now: number,
): InstinctCandidate[] {
  const out: InstinctCandidate[] = [];
  for (const order of orders) {
    // Only a status that MOVED is worth a line; "placed" is what the person
    // already heard when Bro placed it.
    if (order.status !== "cancelled") continue;
    if (order.createdAt !== undefined && now - order.createdAt > 7 * 24 * HOUR) continue;
    out.push({
      kind: "order_update",
      summary: trimLine(`заказ «${order.title}» (${order.merchant}) отменён`),
      ...(order.createdAt !== undefined ? { at: order.createdAt } : {}),
      sourceId: `order:${order._id}`,
    });
  }
  return out;
}

/** Half a scan that fails (no Supermemory key, a timeout) is not a scan that
 *  fails: the other sources still count. Silence is the default anyway. */
async function safeSearch(phone: string, query: string): Promise<ArchiveHit[]> {
  try {
    return await searchArchive(phone, query, ARCHIVE_HITS, ARCHIVE_RECALL_TIMEOUT_MS);
  } catch (err) {
    console.error("instinct archive search failed", err);
    return [];
  }
}

async function safeJobs(phone: string) {
  try {
    return await jobWakeRows(phone);
  } catch (err) {
    console.error("instinct job snapshot failed", err);
    return [];
  }
}

async function safeOrders(phone: string) {
  try {
    return await listOrders(phone);
  } catch (err) {
    console.error("instinct orders failed", err);
    return [];
  }
}

/**
 * Decide whether this scan turns into a model turn, and with what prompt.
 *
 * `{ speak: false }` means the route answers the wakeup without starting a turn
 * at all — the cheapest possible silence, and the common case by design.
 */
export async function runInstinctScan(
  tenantPhone: string,
  now = Date.now(),
): Promise<InstinctScan> {
  const state = await instinctState(tenantPhone);
  if (!state) return { speak: false, reason: "no_tenant" };
  const budget = instinctAllowed({
    sentToday: state.sentToday,
    ...(state.lastSentAt !== undefined ? { lastSentAt: state.lastSentAt } : {}),
    now,
    tz: state.tz ?? "",
    humanActiveRecently: humanActive(state.lastHumanAt, now),
  });
  if (!budget.allowed) return { speak: false, reason: budget.reason };

  const [calendarHits, mailHits, jobs, orders] = await Promise.all([
    safeSearch(tenantPhone, CALENDAR_QUERY),
    safeSearch(tenantPhone, MAIL_QUERY),
    safeJobs(tenantPhone),
    safeOrders(tenantPhone),
  ]);

  const candidates = [
    ...calendarCandidates(calendarHits, now),
    ...mailCandidates(mailHits, now),
    ...errandCandidates(jobs),
    ...orderCandidates(orders, now),
  ];
  const picked = selectCandidates(candidates, state.spoken, now);
  if (picked.length === 0) return { speak: false, reason: "nothing_worth_saying" };
  return {
    speak: true,
    prompt: instinctWakePrompt(picked),
    sourceIds: picked.map((c) => c.sourceId),
  };
}

/** Auth attributes of a turn this scan started (see the wakeup route). One
 *  definition, in the module the guarded tools import — two copies of "is this
 *  an instinct turn?" is exactly the drift that would silently unguard them. */
export { isInstinctTurn as isInstinctWakeup } from "./instinct-guard.ts";

/** Mark what the model was shown, without charging the daily budget. */
export function noteInstinctSources(
  tenantPhone: string,
  sourceIds: readonly string[],
): Promise<void> {
  return noteInstinctSpoken(tenantPhone, sourceIds, false);
}

/**
 * Charge one unprompted message to the person's day.
 *
 * Called from the delivery events, because only they know whether the turn
 * ended in a bubble or in `[SILENT]`. A silent scan interrupted nobody, so it
 * must not cost a slot — otherwise the budget would measure how often Bro
 * LOOKED rather than how often he spoke, and three quiet scans would buy a
 * whole day of silence.
 */
export function spendInstinctSlot(tenantPhone: string): Promise<void> {
  return noteInstinctSpoken(tenantPhone, [], true);
}
