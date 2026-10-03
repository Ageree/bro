import { defineSchedule, type ScheduleToFn } from "eve/schedules";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import scheduledRunChannel from "@agent/channels/scheduled-run";
import {
  probeFailure,
  probeGoogleSignals,
  rankMail,
} from "@agent/lib/proactive/probe";
import {
  eveningMailUntil,
  quietHoursEnd,
} from "@agent/lib/proactive/quiet-hours";
import {
  mailSearchStart,
  proactiveRunPrompt,
  reminderOf,
  selectRunSignals,
} from "@agent/lib/proactive/signals";
import { flightFacts } from "@agent/lib/subscriptions/flight";
import { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import { flightWatchOf } from "@agent/lib/subscriptions/watches";
import {
  advanceProactiveWatermark,
  claimDueProactiveWatches,
  deferProactiveWatch,
  filterUnseenProactiveSignals,
  listProactiveRunSignals,
  type ProactiveSignal,
  pruneProactiveSignals,
  queueProactiveRun,
} from "@db/services/proactive";
import {
  claimReadyScheduledAgentRuns,
  releaseScheduledAgentRun,
  setScheduledRunSession,
} from "@db/services/scheduled-agent-jobs";
import {
  listFlightWatches,
  syncFlightWatches,
} from "@db/services/subscriptions";
import { readUserProfile } from "@db/services/user-profile";
import { localRunLabel } from "@shared/schedules/timing";
import { resolveTimeZone } from "@shared/user-profile/schema";

// Each workspace is looked at every 15 minutes; the cron only spreads the
// checks. A missing Google grant is re-read a few times a day, not every tick.
const checkEveryMs = 15 * 60_000;
/**
 * At most this many model runs per workspace in any 24 hours; past it, new
 * signals wait. Twelve covers a heavy day of mail that matters.
 */
const maxRunsPerDay = 12;
const disconnectedRetryMs = 6 * 60 * 60_000;
const signalRetentionMs = 14 * 24 * 60 * 60_000;
const workerStartupLimitMs = 5 * 60_000;
/**
 * How far back a night check reads subjects: one check's worth, plus the
 * cron's spread and mail dated a little before it arrives. What the previous
 * check read is not read again; a missed check leaves its mail to the
 * morning, which reads everything since the evening.
 */
const nightMailWindowMs = checkEveryMs + 10 * 60_000;

type ClaimedWatch = Awaited<
  ReturnType<typeof claimDueProactiveWatches>
>[number];

export default defineSchedule({
  cron: "*/5 * * * *",
  run({ to, waitUntil }) {
    if (!schedulesEnabled()) return;
    waitUntil(runProactiveChecks(to));
  },
});

async function runProactiveChecks(to: ScheduleToFn) {
  const now = new Date();
  await pruneProactiveSignals(new Date(now.getTime() - signalRetentionMs));
  const watches = await claimDueProactiveWatches({
    leaseForMs: checkEveryMs,
    limit: 25,
    now,
  });
  await Promise.all(watches.map((watch) => checkWorkspace(watch, now)));
  const runs = await claimReadyScheduledAgentRuns({
    kind: "proactive",
    leaseForMs: workerStartupLimitMs,
    limit: 25,
    now,
  });
  await Promise.all(runs.map((claim) => dispatchProactiveRun(to, claim)));
}

/**
 * One check, logged as one line with its outcome: in production that line is
 * how to tell a quiet inbox from a check that never ran. In the
 * subscriptions pilot the evening's ordinary mail waits for the morning from
 * 21:00 (`eveningMailUntil`): the check then looks only for what cannot
 * wait, as at night, and the morning reads the whole evening as one batch.
 */
async function checkWorkspace(watch: ClaimedWatch, now: Date) {
  const timeZone = resolveTimeZone(watch.timezone);
  const pilot = await subscriptionsPilot({
    userId: watch.createdByUserId,
    workspaceId: watch.workspaceId,
  });
  const quietUntil = quietHoursEnd(now, timeZone);
  const eveningUntil =
    pilot && !quietUntil ? eveningMailUntil(now, timeZone) : undefined;
  const logged = {
    ...(eveningUntil && { evening: true }),
    night: quietUntil !== undefined,
    workspaceId: watch.workspaceId,
  };
  const check = { evening: eveningUntil !== undefined, pilot, timeZone };
  try {
    const result = await (quietUntil
      ? checkAtNight(watch, now, check, quietUntil)
      : eveningUntil
        ? checkAtNight(watch, now, check, eveningUntil)
        : checkByDay(watch, now, check));
    console.info("[proactive] check", { ...logged, ...result });
  } catch (error) {
    // The claim already moved the next check out; a Google hiccup waits for it.
    console.warn("[proactive] check", {
      ...logged,
      cause: error,
      failure: probeFailure(error),
      outcome: "failed",
    });
  }
}

/**
 * How a workspace is checked: its zone, whether it is in the pilot, and
 * whether it is the evening, when only mail waits for the morning.
 */
interface CheckMode {
  readonly evening: boolean;
  readonly pilot: boolean;
  readonly timeZone: string;
}

/**
 * Keeps a watch for each flight the check read (`syncFlightWatches`), in the
 * subscriptions pilot: those watches remind of flights by the clock
 * (`agent/schedules/subscriptions.ts`). A failure here is logged and leaves
 * the check itself alone.
 */
async function syncFlights(
  watch: ClaimedWatch,
  now: Date,
  probe: Pick<Parameters<typeof syncFlightWatches>[0], "flights" | "seenUntil">
) {
  try {
    const synced = await syncFlightWatches({
      ...probe,
      jobId: watch.jobId,
      now,
      scope: { userId: watch.createdByUserId, workspaceId: watch.workspaceId },
    });
    return synced.started > 0 || synced.ended > 0 ? { flights: synced } : {};
  } catch (error) {
    console.warn("[proactive] flight watches not synced", {
      name: error instanceof Error ? error.name : "error",
      workspaceId: watch.workspaceId,
    });
    return {};
  }
}

/**
 * A daytime check hands every new signal to one run. The reports held over
 * the night go out with the first report of the morning, as one message
 * (`absorbHeldProactiveReports`).
 */
async function checkByDay(
  watch: ClaimedWatch,
  now: Date,
  { pilot, timeZone }: CheckMode
) {
  const probe = await probeGoogleSignals(
    { userId: watch.createdByUserId, workspaceId: watch.workspaceId },
    {
      flightReminders: !pilot,
      mailAfter: mailSearchStart(watch.mailCheckedAt, now),
      now,
      timeZone,
    }
  );
  if (probe.state !== "connected") return disconnect(watch, now, probe.state);
  const synced = pilot
    ? await syncFlights(watch, now, {
        flights: probe.flights,
        seenUntil: probe.calendarSeenUntil,
      })
    : {};
  const unseen = await filterUnseenProactiveSignals(
    watch.workspaceId,
    probe.signals
  );
  if (unseen.length === 0) {
    await advanceProactiveWatermark(watch.workspaceId, now);
    return { outcome: "nothing_new", signalCount: 0, ...synced };
  }
  // After a pause (a reconnect, the end of quiet hours, turning proactive
  // messages back on) the backlog becomes one catch-up run; the watermark
  // moves past the rest instead of queuing batch after batch of old mail.
  const { droppedMail, signals } = await catchUpSignals(watch, unseen);
  const queued = await queueProactiveRun({
    jobId: watch.jobId,
    mailCheckedAt: now,
    maxRunsPerDay,
    now,
    signals,
    workspaceId: watch.workspaceId,
  });
  return {
    outcome: queued.status,
    signalCount: unseen.length,
    ...(droppedMail > 0 && { droppedMail }),
    ...synced,
  };
}

/**
 * The signals of one run. When the new mail does not fit, what matters goes
 * first — flights, security, parcels, people — and newsletters are what is
 * left out (`mailRank`); the count left out goes to the check's log line.
 */
async function catchUpSignals(
  watch: ClaimedWatch,
  unseen: readonly ProactiveSignal[]
) {
  const mail = unseen.filter((signal) => signal.source === "gmail");
  const newest = selectRunSignals(unseen);
  const droppedMail =
    mail.length - newest.filter((signal) => signal.source === "gmail").length;
  if (droppedMail === 0) return { droppedMail, signals: newest };
  const ranks = await rankMail(
    { userId: watch.createdByUserId, workspaceId: watch.workspaceId },
    mail
  );
  return { droppedMail, signals: selectRunSignals(unseen, ranks) };
}

/**
 * At night only what cannot wait starts a run: a flight leaving within hours
 * or, until 23:00, tonight's reminder of one tomorrow morning, and mail about
 * a flight or an account's security. The watermark stays, so the
 * morning check reads the rest of the night's mail as one batch, and the
 * check after the last night one runs right when the night ends. Subjects are
 * read only for mail since the previous night check (`nightMailWindowMs`):
 * with the watermark still, every check re-read the evening's mail again.
 */
async function checkAtNight(
  watch: ClaimedWatch,
  now: Date,
  { evening, pilot, timeZone }: CheckMode,
  quietUntil: Date
) {
  const probe = await probeGoogleSignals(
    { userId: watch.createdByUserId, workspaceId: watch.workspaceId },
    {
      flightReminders: !pilot,
      // In the evening only mail waits: a new event still starts a run.
      ...(evening && { nightCalendar: "all" as const }),
      mailAfter: new Date(
        Math.max(
          mailSearchStart(watch.mailCheckedAt, now).getTime(),
          now.getTime() - nightMailWindowMs
        )
      ),
      nightOnly: true,
      now,
      timeZone,
    }
  );
  if (probe.state !== "connected") return disconnect(watch, now, probe.state);
  const synced = pilot
    ? await syncFlights(watch, now, {
        flights: probe.flights,
        seenUntil: probe.calendarSeenUntil,
      })
    : {};
  const unseen = await filterUnseenProactiveSignals(
    watch.workspaceId,
    probe.signals
  );
  const queued =
    unseen.length > 0
      ? await queueProactiveRun({
          jobId: watch.jobId,
          mailCheckedAt: watch.mailCheckedAt,
          maxRunsPerDay,
          now,
          signals: selectRunSignals(unseen),
          workspaceId: watch.workspaceId,
        })
      : undefined;
  if (quietUntil < watch.leaseUntil) {
    await deferProactiveWatch(watch, quietUntil);
  }
  return {
    outcome: `night_${queued?.status ?? "quiet"}`,
    signalCount: unseen.length,
    ...synced,
  };
}

async function disconnect(
  watch: ClaimedWatch,
  now: Date,
  state: "disconnected" | "unavailable"
) {
  // A connection completed during the probe woke the watch; then this
  // deferral misses and the next tick looks again.
  const deferred = await deferProactiveWatch(
    watch,
    new Date(now.getTime() + disconnectedRetryMs),
    "disconnected"
  );
  return { deferred, outcome: state, signalCount: 0 };
}

async function dispatchProactiveRun(
  to: ScheduleToFn,
  claim: Awaited<ReturnType<typeof claimReadyScheduledAgentRuns>>[number]
) {
  const leaseToken = claim.run.leaseToken;
  if (!leaseToken) throw new Error("A scheduled run claim requires a lease.");
  try {
    const scope = {
      userId: claim.job.createdByUserId,
      workspaceId: claim.job.workspaceId,
    };
    const [signals, profile] = await Promise.all([
      listProactiveRunSignals(claim.run.id),
      readUserProfile(scope),
    ]);
    const timeZone = resolveTimeZone(profile.timezone);
    const quietUntil = quietHoursEnd(new Date(), timeZone);
    const facts = (await subscriptionsPilot(scope))
      ? await reminderFacts(claim.job.workspaceId, signals, timeZone)
      : undefined;
    const session = await to(scheduledRunChannel, {
      restart: claim.run.workerSessionId !== null,
      runId: claim.run.id,
    }).send(
      proactiveRunPrompt({
        flightFacts: facts,
        home: profile,
        quietUntil: quietUntil && localRunLabel(quietUntil, timeZone),
        scheduledFor: claim.run.scheduledFor,
        signals,
      }),
      {
        auth: {
          attributes: {
            conversationChannel: claim.job.conversationChannel,
            conversationId: claim.job.conversationId,
            scheduleId: claim.job.id,
            scheduledRunKind: "proactive",
            scheduledRunLeaseToken: leaseToken,
            scheduledRunId: claim.run.id,
            workspaceId: claim.job.workspaceId,
          },
          authenticator: "scheduled-worker",
          issuer: "open-instinct",
          principalId: claim.job.createdByUserId,
          principalType: "user" as const,
        },
      }
    );
    const persisted = await setScheduledRunSession(
      claim.run.id,
      leaseToken,
      session.id
    );
    if (!persisted) {
      throw new Error("The scheduled run lease expired during dispatch.");
    }
  } catch (error) {
    console.warn("[proactive] worker dispatch failed", {
      cause: error,
      runId: claim.run.id,
    });
    await releaseScheduledAgentRun(
      claim.run.id,
      leaseToken,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * The facts code counted for the flights a run reminds of (`flightFacts`),
 * by event id, from their watches; none outside the subscriptions pilot,
 * where the check reminds of flights itself. The newest watch of an event
 * wins: a moved flight's old one has its old time.
 */
async function reminderFacts(
  workspaceId: string,
  signals: readonly Pick<ProactiveSignal, "dedupeKey" | "itemId">[],
  timeZone: string
) {
  const eventIds = [
    ...new Set(
      signals.flatMap((signal) =>
        reminderOf(signal.dedupeKey) ? [signal.itemId] : []
      )
    ),
  ];
  const facts = new Map<string, string>();
  for (const row of await listFlightWatches(workspaceId, eventIds)) {
    const watch = flightWatchOf(row);
    if (!watch || facts.has(watch.source.eventId)) continue;
    const counted = flightFacts(watch, timeZone);
    if (counted) facts.set(watch.source.eventId, counted);
  }
  return facts;
}
