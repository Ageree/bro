import { type EnvoyBrief, meetingMinutes } from "@agent/lib/bro-to-bro/brief";
import { writeBroCalendars } from "@agent/lib/bro-to-bro/calendar";
import { envoyPackage, planEnvoyStep } from "@agent/lib/bro-to-bro/envoy";
import { type GateVerdict, screenOutgoing } from "@agent/lib/bro-to-bro/gate";
import { readSlotCandidates } from "@agent/lib/bro-to-bro/slots";
import {
  expireBroThreads,
  purgeBroThreads,
} from "@db/services/bro-to-bro/expiry";
import { readBroPeople } from "@db/services/bro-to-bro/people";
import {
  claimDueBroThreads,
  envoyMessageLimit,
  recordEnvoyFailure,
  recordEnvoyStep,
  releaseBroThread,
  renewBroThreadLease,
} from "@db/services/bro-to-bro/steps";
import { readBroThreadForSide } from "@db/services/bro-to-bro/threads";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import { db } from "@db";
import { env } from "@shared/environment";

/** New steps start only this long into a tick; one under way finishes. */
const tickMs = 45_000;
/** A thread's lease, longer than one step at its slowest. */
const leaseMs = 120_000;
/** One step (the envoy, its retry, the gate) gives up before the lease ends. */
const stepTimeoutMs = 100_000;
const claimLimit = 5;
/** A thread taken up again and again in one tick waits for the next. */
const drivesPerTick = 3;
const purgeEveryMs = 60 * 60_000;
const hourMs = 60 * 60_000;
const dayMs = 24 * hourMs;
/** No time is offered sooner than this from now. */
const slotLeadMs = 2 * hourMs;
/**
 * How far ahead a side without its owner's window looks for a time: the
 * responder always, the initiator when the errand named no window.
 */
const initiatorDays = 7;
const responderDays = 14;

type BroThreadView = NonNullable<
  Awaited<ReturnType<typeof readBroThreadForSide>>
>;
type EnvoyStepRecord = Parameters<typeof recordEnvoyStep>[2];
type HeldReasons = Extract<GateVerdict, { verdict: "hold" }>["reasons"];

/** What the gate held, as the owner hears it: categories, never the words. */
const heldWords = new Map([
  ["address", "адрес"],
  ["card", "номер карты"],
  ["contact", "контакт"],
  ["credentials", "пароли и коды"],
  ["document", "номер документа"],
  ["email", "почта"],
  ["health", "здоровье"],
  ["link", "ссылка"],
  ["location", "где ты"],
  ["money", "деньги"],
  ["number", "длинный номер"],
  ["other", "личные сведения"],
  ["people", "другие люди"],
  ["phone", "телефон"],
  ["plans", "планы"],
  ["preferences", "предпочтения"],
  ["relationships", "отношения"],
  ["secret", "секрет"],
  ["time", "время"],
  ["work", "работа"],
]);

/**
 * Why the gate held a draft, in the owner's words. A time is held either
 * outside the owner's free windows or because there is no calendar to check
 * it against; the owner must not hear the one for the other (a report of
 * 23.10 told Savely 19:30 «was not in Petya's free windows»).
 */
function heldReason(reasons: HeldReasons, slots: EnvoyBrief["slots"]) {
  const words = reasons.map((reason) => {
    if (reason.by === "unchecked") return "проверка не ответила";
    if (reason.by === "code" && reason.finding === "time")
      return slots.state === "known"
        ? "время вне твоих свободных окон"
        : "время без твоего календаря";
    // A model's reason quotes the packet after its category: only the
    // category goes on.
    const category =
      reason.by === "code"
        ? reason.finding
        : (reason.text.split(":", 1)[0] ?? "other");
    return heldWords.get(category) ?? heldWords.get("other") ?? category;
  });
  return [...new Set(words)].join(", ");
}

/**
 * The brief of the side whose turn it is (docs/bro-to-bro.md, «Что видит
 * посол»), built from what that side may read of its thread: its owner's
 * name and zone, the peer's name — never the owner's own label for them —
 * what the owner opens to the peer, its own mandate and answers, the times
 * its calendar offers within the thread's window (none sooner than two
 * hours from now) for a meeting as long as `meetingMinutes` says, and the
 * messages that passed. The responder's goal is the topic of the peer's
 * first message, and its window the next 14 days; a window past that is
 * only the one the initiator's owner gave. The window's end is the
 * horizon: the free time around the peer's latest proposal within it is
 * among the times, so that the envoy can accept it when its owner is free
 * then, and of a proposal past it the envoy asks the owner — the calendar
 * says nothing of it.
 */
export async function buildEnvoyBrief(
  view: BroThreadView,
  workspaceId: string,
  signal?: AbortSignal
): Promise<EnvoyBrief> {
  const { link } = view;
  if (!link) throw new Error("A Bro thread without its link has no brief.");
  const scope = { userId: view.own.userId, workspaceId };
  const now = new Date();
  const mandate = view.side === "initiator" ? view.own.mandate : null;
  const goal =
    mandate?.goal ??
    view.topic ??
    view.messages.find((message) => message.from === "peer")?.body;
  if (!goal) throw new Error("A Bro thread has no goal to move on.");
  const offered = view.messages.findLast(
    (message) => message.action === "propose"
  );
  const window = mandate?.window ?? {
    from: now.toISOString(),
    to: new Date(
      now.getTime() +
        (view.side === "initiator" ? initiatorDays : responderDays) * dayMs
    ).toISOString(),
  };
  const around =
    offered?.from === "peer" &&
    offered.proposal?.start &&
    offered.proposal.end &&
    Date.parse(offered.proposal.end) <= Date.parse(window.to)
      ? { end: offered.proposal.end, start: offered.proposal.start }
      : undefined;
  const durationMinutes = meetingMinutes(mandate, view.messages);
  const [people, timeZone] = await Promise.all([
    readBroPeople(db, [workspaceId]),
    readWorkspaceTimeZone(scope),
  ]);
  const slots = link.calendar
    ? await readSlotCandidates(scope, {
        around,
        durationMinutes,
        signal,
        timeZone,
        window: {
          from: new Date(
            Math.max(Date.parse(window.from), now.getTime() + slotLeadMs)
          ).toISOString(),
          to: window.to,
        },
      })
    : ({ state: "not_granted" } as const);
  return {
    role: view.side,
    self: { name: people.get(workspaceId)?.name ?? "владелец", timeZone },
    peer: { name: view.peer.name ?? "собеседник" },
    shareNotes: link.shareNotes,
    goal,
    mandate,
    durationMinutes,
    ownerAnswers: view.own.ownerAnswers,
    slots,
    transcript: view.messages.map((message) => {
      const entry = {
        action: message.action,
        at: message.createdAt.toISOString(),
        from: message.from,
        id: message.id,
        text: message.body,
      };
      return message.proposal
        ? { ...entry, proposal: message.proposal }
        : entry;
    }),
    openProposalId: view.openProposalId,
    horizon: window.to,
    messagesLeft: Math.max(0, envoyMessageLimit - view.envoyMessages),
    now: now.toISOString(),
  };
}

/**
 * What the side says this step: a draft its owner approved goes word for
 * word, with no model and no gate; otherwise the envoy decides, and
 * whatever would reach the peer — the package, or the «уточню и вернусь»
 * of a question to the owner — passes the gate first. A held package waits
 * for the owner; a held «уточню и вернусь» is just not said.
 */
async function decideStep(
  view: BroThreadView,
  workspaceId: string
): Promise<Pick<EnvoyStepRecord, "outOfScope" | "outcome">> {
  const held = view.own.heldMessage;
  if (held?.approved)
    return { outOfScope: [], outcome: { draftId: held.id, kind: "sent_held" } };
  const signal = AbortSignal.timeout(stepTimeoutMs);
  const call = { signal, workspaceId };
  const brief = await buildEnvoyBrief(view, workspaceId, signal);
  const { decision } = await planEnvoyStep(brief, call);
  const allowed = {
    approvedTexts: view.messages
      .filter((message) => message.approvedByOwner)
      .flatMap((message) =>
        [
          message.body,
          message.proposal?.summary,
          message.proposal?.place,
        ].filter((text) => text !== undefined)
      ),
    goal: brief.goal,
    peer: brief.peer,
    role: brief.role,
    self: brief.self,
    shareNotes: brief.shareNotes,
    slots: brief.slots,
  };
  const packet = envoyPackage(decision);
  if (packet) {
    const verdict = await screenOutgoing({ allowed, packet }, call);
    return {
      outOfScope: decision.outOfScope,
      outcome:
        verdict.verdict === "pass"
          ? { kind: "sent", message: packet }
          : {
              draft: packet,
              kind: "held",
              reason: heldReason(verdict.reasons, brief.slots),
            },
    };
  }
  const message = decision.message ?? null;
  const said =
    message !== null &&
    (await screenOutgoing({ allowed, packet: { body: message } }, call))
      .verdict === "pass";
  return {
    outOfScope: decision.outOfScope,
    outcome: {
      kind: "asked_owner",
      message: said ? message : null,
      question: decision.ownerQuestion ?? "",
    },
  };
}

/**
 * One envoy step of the side `workspaceId` holds, under the thread's lease:
 * the step is recorded only while the thread, its link and their revisions
 * are still what the brief was built on, and a step built on anything older
 * is dropped without a trace. «passed» when a message went out and the
 * peer's envoy moves next.
 */
export async function runEnvoyStep(step: {
  readonly leaseToken: string;
  readonly threadId: string;
  readonly workspaceId: string;
}) {
  const view = await readBroThreadForSide(step.threadId, step.workspaceId);
  if (
    !view?.link ||
    view.status !== "negotiating" ||
    view.nextSide !== view.side ||
    view.own.waitingOwner
  )
    return "stopped" as const;
  let decided;
  try {
    decided = await decideStep(view, step.workspaceId);
  } catch (error) {
    // The cause's name only: a message may quote the thread.
    console.warn("[bro-to-bro] envoy step failed", {
      error: error instanceof Error ? error.name : "unknown",
      threadId: step.threadId,
    });
    await recordEnvoyFailure(step.threadId, step.leaseToken);
    return "stopped" as const;
  }
  const recorded = await recordEnvoyStep(step.threadId, step.leaseToken, {
    ...decided,
    linkRevisions: view.link.revisions,
    side: view.side,
    threadVersion: view.version,
  });
  if (recorded.kind === "rejected") {
    // A decision code refused counts as a failed step; anything that moved
    // under the step (the version, the link, the lease) is no failure.
    if (recorded.reason === "package")
      await recordEnvoyFailure(step.threadId, step.leaseToken);
    return "stopped" as const;
  }
  const { kind } = decided.outcome;
  return recorded.status === "negotiating" &&
    (kind === "sent" || kind === "sent_held")
    ? ("passed" as const)
    : ("stopped" as const);
}

type ClaimedThread = Awaited<ReturnType<typeof claimDueBroThreads>>[number];

/**
 * A leased thread's envoys take turns while it has a move and the tick
 * lasts. The lease is renewed before each step: a step that starts late in
 * the tick may run past the lease it was claimed with, and would be dropped
 * while another tick took the thread and paid the model again.
 */
async function driveThread(thread: ClaimedThread, started: number) {
  const sides = [thread.workspaceId, thread.peerWorkspaceId] as const;
  try {
    for (let turn = 0; Date.now() - started < tickMs; turn += 1) {
      /* oxlint-disable eslint/no-await-in-loop -- The envoys of one thread speak in turn. */
      if (
        !(await renewBroThreadLease(
          thread.threadId,
          thread.leaseToken,
          leaseMs
        ))
      )
        break;
      const moved = await runEnvoyStep({
        leaseToken: thread.leaseToken,
        threadId: thread.threadId,
        workspaceId: sides[turn % 2] ?? thread.workspaceId,
      });
      /* oxlint-enable eslint/no-await-in-loop */
      if (moved !== "passed") break;
    }
  } finally {
    await releaseBroThread(thread.threadId, thread.leaseToken);
  }
}

let running: Promise<void> | undefined;
/** Wakes that came while a run was under way. */
let wakes = 0;
let purgedAt = 0;

async function tick() {
  const started = Date.now();
  const driven = new Map<string, number>();
  let handled: number;
  /* oxlint-disable eslint/no-await-in-loop -- A tick claims threads round after round until none is due or its time is up. */
  do {
    handled = wakes;
    await expireBroThreads();
    if (Date.now() - purgedAt >= purgeEveryMs) {
      purgedAt = Date.now();
      await purgeBroThreads();
    }
    await writeBroCalendars();
    while (Date.now() - started < tickMs) {
      const claimed = await claimDueBroThreads({ leaseMs, limit: claimLimit });
      const due = claimed.filter(
        (thread) => (driven.get(thread.threadId) ?? 0) < drivesPerTick
      );
      await Promise.all(
        claimed
          .filter((thread) => !due.includes(thread))
          .map((thread) => releaseBroThread(thread.threadId, thread.leaseToken))
      );
      if (due.length === 0) break;
      for (const thread of due)
        driven.set(thread.threadId, (driven.get(thread.threadId) ?? 0) + 1);
      await Promise.all(due.map((thread) => driveThread(thread, started)));
    }
  } while (wakes !== handled && Date.now() - started < tickMs);
  /* oxlint-enable eslint/no-await-in-loop */
}

/**
 * Moves Bro ↔ Bro on (docs/bro-to-bro.md, «Двигатель»): closes threads past
 * their deadline, erases what outlived its keeping (once an hour), puts the
 * meetings both owners confirmed in their calendars, and lets every due
 * thread's envoys speak for up to ~45 s. Threads are leased, so
 * two processes never step one thread twice; within a process one run goes
 * at a time, and a wake that comes during it (a tool's `void` call) makes
 * that run look for due threads once more. Off without the flag, and on a
 * database without transactions.
 */
export function runBroToBroSteps() {
  if (
    (env.BRO_TO_BRO_WORKSPACES ?? []).length === 0 ||
    env.DATABASE_DRIVER === "neon-http"
  )
    return Promise.resolve();
  if (running) {
    wakes += 1;
    return running;
  }
  running = (async () => {
    try {
      await tick();
    } catch (error) {
      console.warn("[bro-to-bro] steps unavailable", {
        error: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      running = undefined;
    }
  })();
  return running;
}
