import type {
  Client,
  ClientSession,
  InputRequest,
  InputResponse,
  MessageStreamEvent,
} from "eve/client";
import { setTimeout as sleep } from "node:timers/promises";
import { decideInputRequest } from "./approvals.ts";
import type { BenchCase } from "./cases.ts";
import { isNight } from "./clock.ts";
import {
  CaseJournal,
  deliveredText,
  isoWithOffset,
  type DriverStatus,
  type ObservationChannel,
  type RunRecord,
  type TesterTurnKind,
} from "./journal.ts";
import { messageContent, type OutgoingFile } from "./media.ts";
import { stepOffsetMs, type PlannedStep } from "./steps.ts";
import { TurnTracker } from "./tracker.ts";

/**
 * Drives one benchmark case through the eve client the web chat uses: opens
 * the conversation, sends each scripted message, answers approval cards by
 * the benchmark's rules, and, when a browser errand is still running, follows
 * the session for its result — asking «ну что там?» (a counted hint) only if
 * the result does not arrive on its own.
 */

export interface DriverSettings {
  readonly approvedTools: readonly string[];
  /** How long to follow a session for background results; 0 skips it. */
  readonly backgroundWaitMs: number;
  /** Upper bound, in roubles, up to which a payment card is confirmed for
   * the owner (`--confirm-payment-up-to`); undefined keeps every payment
   * card cancelled, as before the flag existed. */
  readonly confirmPaymentUpToRub: number | undefined;
  readonly extraFiles: readonly OutgoingFile[];
  /** Tools whose approval card the driver leaves for the owner (`--hold`). */
  readonly heldTools: readonly string[];
  readonly hintText: string;
  readonly host: string;
  /** Follow-and-ask rounds while a background errand stays silent. */
  readonly nudges: number;
  readonly outDir: string;
  /** A new run keeps the script's «T+…» waits; kept in its record. */
  readonly paced: boolean;
  readonly tester: string;
  readonly timeZone: string;
  /** Upper bound for one turn, approvals included. */
  readonly turnTimeoutMs: number;
  readonly voice: readonly string[];
}

/**
 * A step due this soon is waited for in place (d15's «T+10мин»); a later one
 * ends the run as `scheduled` until `pnpm bench next`.
 */
const inlineWaitMs = 15 * 60_000;

class TurnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`No turn boundary within ${String(Math.round(timeoutMs / 1000))} s.`);
    this.name = "TurnTimeoutError";
  }
}

/** One case in flight: its journal, its record, and what the stream showed. */
class CaseRun {
  readonly journal: CaseJournal;
  readonly record: RunRecord;
  readonly settings: DriverSettings;
  readonly tracker: TurnTracker;
  /** The scripted step the run stopped before because it is due later. */
  deferred: { readonly at: string; readonly dueAt: Date } | undefined;
  // A response moves its session's cursor only once its turn is read, so
  // the record takes the cursors from the handles when it is saved.
  readonly #handles = new Set<ClientSession>();

  constructor(
    journal: CaseJournal,
    record: RunRecord,
    settings: DriverSettings
  ) {
    this.journal = journal;
    this.record = record;
    this.settings = settings;
    this.tracker = new TurnTracker(
      record.driver.pendingInputs,
      record.driver.backgroundRuns
    );
  }

  /** Saves this session's cursor with the record even if nothing arrives. */
  attach(session: ClientSession) {
    this.#handles.add(session);
  }

  async observe(session: ClientSession, event: MessageStreamEvent) {
    this.#handles.add(session);
    this.tracker.observe(event);
    await this.journal.event(session.state.sessionId, event);
  }

  async save(status: DriverStatus, detail: string | null = null) {
    const { driver } = this.record;
    driver.status = status;
    driver.statusDetail = detail;
    driver.pendingInputs = [...this.tracker.pending.values()];
    driver.backgroundRuns = this.tracker.backgroundRuns();
    for (const { state } of this.#handles) {
      const known = driver.sessions.find(
        (cursor) => cursor.sessionId === state.sessionId
      );
      if (known) known.streamIndex = state.streamIndex;
      else driver.sessions.push({ ...state });
    }
    this.record.productVersion ??= this.tracker.productVersion ?? null;
    this.record.finishedAt = isoWithOffset(new Date(), this.settings.timeZone);
    await this.journal.save(this.record);
  }

  /**
   * Saves where the case ended: blocked on a person, still waiting for a
   * browser errand's result, or done.
   */
  async settle() {
    const blocked = this.tracker.blocked(this.settings.heldTools);
    if (blocked) {
      const held = [...this.tracker.pending.values()].some(
        (request) =>
          request.kind === "tool-approval" &&
          this.settings.heldTools.includes(request.action.toolName)
      );
      const detail = held
        ? `${blocked[1]} — ответить: pnpm bench send --out ${this.settings.outDir} --case ${this.record.caseId} --option approve|cancel`
        : blocked[1];
      await this.save(blocked[0], detail);
      return;
    }
    if (this.tracker.awaitingBackground()) {
      const { backgroundWaitMs } = this.settings;
      const waited =
        backgroundWaitMs > 0
          ? `фоновый итог не пришёл за ${String(Math.round(backgroundWaitMs / 60_000))} мин`
          : "фоновое поручение ещё идёт, ожидание выключено";
      await this.save(
        "timed-out",
        `${waited}; дождаться: pnpm bench follow --out ${this.settings.outDir} --case ${this.record.caseId}`
      );
      return;
    }
    // A paced case still has its later steps after a hint or a cleanup turn.
    const [nextStep] = this.record.driver.remainingSteps;
    const deferred =
      this.deferred ??
      (this.record.driver.paced && nextStep
        ? { at: nextStep.at, dueAt: this.dueAt(nextStep.at) }
        : undefined);
    if (deferred) {
      await this.save(
        "scheduled",
        `следующий шаг «${deferred.at}» — не раньше ${isoWithOffset(deferred.dueAt, this.settings.timeZone)}: pnpm bench next --out ${this.settings.outDir} --case ${this.record.caseId}`
      );
      return;
    }
    await this.save("completed");
  }

  async noteTurn(
    session: ClientSession,
    kind: TesterTurnKind,
    at: string,
    text: string
  ) {
    this.record.driver.turns.push({
      at,
      kind,
      sentAt: isoWithOffset(new Date(), this.settings.timeZone),
      sessionId: session.state.sessionId,
      text,
    });
    if (kind === "hint") this.record.hints += 1;
    if (kind === "code") this.record.codesRequested += 1;
    await this.journal.line(`== тестировщик (${kind}, ${at}): ${text}`);
  }

  /** When a scripted step is due: its «T+…» after the run started. */
  dueAt(at: string) {
    return new Date(Date.parse(this.record.startedAt) + stepOffsetMs(at));
  }
}

const savedStep = (step: PlannedStep) => ({
  at: step.at,
  files: [...step.files],
  manual: step.manual,
  newConversation: step.newConversation,
  text: step.text,
});

const plannedSteps = (
  saved: RunRecord["driver"]["remainingSteps"]
): PlannedStep[] => saved.map((step) => ({ ...step, manual: step.manual }));

/**
 * Reads a turn's events until its boundary. An authorization request parks
 * the turn until someone finishes a consent screen, which the driver cannot
 * do, so the read stops at the parking `session.waiting`.
 */
async function readTurn(
  run: CaseRun,
  session: ClientSession,
  events: AsyncIterable<MessageStreamEvent>
) {
  for await (const event of events) {
    await run.observe(session, event);
    if (event.type === "session.waiting" && run.tracker.authorizationPending) {
      break;
    }
  }
}

/** Runs one exchange with a deadline covering the POST and the stream. */
async function exchange(
  run: CaseRun,
  start: (signal: AbortSignal) => Promise<{
    readonly events: AsyncIterable<MessageStreamEvent>;
    readonly session: ClientSession;
  }>
) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new TurnTimeoutError(run.settings.turnTimeoutMs));
  }, run.settings.turnTimeoutMs);
  try {
    const { events, session } = await start(controller.signal);
    await readTurn(run, session, events);
    return session;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new TurnTimeoutError(run.settings.turnTimeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Answers the cards the rules decide (approvals, session limits) until only
 * questions for the tester are left, or none.
 */
async function settleInputs(run: CaseRun, session: ClientSession) {
  // A card is answered once, even if eve never reports it resolved.
  const answered = new Set<string>();
  for (;;) {
    if (run.tracker.authorizationPending) return;
    const responses: InputResponse[] = [];
    for (const request of run.tracker.pending.values()) {
      if (answered.has(request.requestId)) continue;
      const decision = decideInputRequest(
        request,
        run.settings.approvedTools,
        run.settings.heldTools,
        run.settings.confirmPaymentUpToRub
      );
      if (decision.kind !== "respond") {
        if (request.kind === "tool-approval") {
          const cardOptions = (request.options ?? [])
            .map((option) => `${option.id} («${option.label}»)`)
            .join(", ");
          // oxlint-disable-next-line eslint/no-await-in-loop -- log lines keep the order of the decisions
          await run.journal.line(
            `== драйвер держит карточку ${request.action.toolName} — ${decision.reason}\n   ${request.prompt}${cardOptions ? ` [${cardOptions}]` : ""}\n   ответить: pnpm bench send --out ${run.settings.outDir} --case ${run.record.caseId} --option approve|cancel`
          );
        }
        continue;
      }
      answered.add(request.requestId);
      responses.push(decision.response);
      run.record.driver.decisions.push({
        optionId: decision.response.optionId,
        reason: decision.reason,
        requestId: request.requestId,
        tool: request.action.toolName,
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- log lines keep the order of the decisions
      await run.journal.line(
        `== драйвер: ${decision.response.optionId ?? "ответ"} на ${request.action.toolName} — ${decision.reason}`
      );
    }
    if (responses.length === 0) return;
    // oxlint-disable-next-line eslint/no-await-in-loop -- each answer can raise the next card
    await exchange(run, async (signal) => ({
      events: await session.respond(responses, { signal }),
      session,
    }));
  }
}

/**
 * Follows the session while a browser errand runs, as a person would wait
 * for the result. Returns whether the result arrived on its own.
 */
async function awaitBackground(run: CaseRun, session: ClientSession) {
  const { backgroundWaitMs } = run.settings;
  if (!run.tracker.awaitingBackground() || backgroundWaitMs <= 0) return true;
  await run.journal.line(
    `== драйвер ждёт фоновый итог до ${String(Math.round(backgroundWaitMs / 60_000))} мин`
  );
  const deadline = Date.now() + backgroundWaitMs;
  // A manual stream gives up after a few idle reconnects, far sooner than an
  // errand reports, so it is reopened until the deadline.
  while (run.tracker.awaitingBackground() && Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, deadline - Date.now());
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one stream at a time, reopened in order
      for await (const event of session.stream({ signal: controller.signal })) {
        await run.observe(session, event);
        const settledTurn =
          event.type === "session.waiting" &&
          (!run.tracker.awaitingBackground() || run.tracker.pending.size > 0);
        if (settledTurn || run.tracker.authorizationPending) break;
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
    }
    if (run.tracker.blocked(run.settings.heldTools)) break;
    // oxlint-disable-next-line eslint/no-await-in-loop -- a card raised by the background turn is answered before waiting on
    await settleInputs(run, session);
    // oxlint-disable-next-line eslint/no-await-in-loop -- a pause before reopening an idle stream
    if (!controller.signal.aborted) await sleep(1000);
  }
  return !run.tracker.awaitingBackground();
}

/** Waits for background results and nudges once per round when they stay silent. */
async function finishBackground(run: CaseRun, session: ClientSession) {
  for (let round = 0; round <= run.settings.nudges; round += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each round waits for the previous one's result
    if (await awaitBackground(run, session)) return;
    if (
      round === run.settings.nudges ||
      run.tracker.blocked(run.settings.heldTools)
    ) {
      return;
    }
    const hint = run.settings.hintText;
    // oxlint-disable-next-line eslint/no-await-in-loop -- the hint goes only after the wait ran out
    await run.noteTurn(session, "hint", "после ожидания фонового итога", hint);
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by nature
    await exchange(run, async (signal) => ({
      events: await session.send(hint, { signal }),
      session,
    }));
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by nature
    await settleInputs(run, session);
  }
}

function newRecord(
  benchCase: BenchCase,
  settings: DriverSettings,
  journal: CaseJournal,
  steps: readonly PlannedStep[],
  scriptNotes: readonly string[]
): RunRecord {
  return {
    caseId: benchCase.id,
    channel: "веб",
    cleanupDone: false,
    codesRequested: 0,
    driver: {
      backgroundRuns: [],
      decisions: [],
      fixtures: steps.flatMap((step) =>
        step.files.map((file) => ({ file: file.path, shows: file.shows }))
      ),
      host: settings.host,
      observations: [],
      paced: settings.paced,
      pendingInputs: [],
      remainingSteps: [],
      riskLevel: benchCase.riskLevel ?? null,
      scriptNotes: [...scriptNotes],
      sessions: [],
      status: "completed",
      statusDetail: null,
      suite: benchCase.suite,
      title: benchCase.title,
      turns: [],
    },
    evidence: [journal.paths.log, journal.paths.events],
    finishedAt: null,
    hints: 0,
    naReason: null,
    notes: "",
    outcome: null,
    product: "Бро",
    productVersion: null,
    promptSent: steps.map((step) => step.text).join("\n---\n"),
    safetyViolations: [],
    score: null,
    startedAt: isoWithOffset(new Date(), settings.timeZone),
    tester: settings.tester,
    timezone: settings.timeZone,
    transcript: journal.paths.log,
    vpnNeeded: false,
  };
}

async function failRun(run: CaseRun, error: Error) {
  await run.journal.line(`!! драйвер: ${error.message}`);
  await run.save(
    error instanceof TurnTimeoutError ? "timed-out" : "failed",
    error.message
  );
}

/**
 * Sends scripted messages in order, answering the cards the rules decide
 * after each. Stops at a question for the tester and keeps the steps still
 * to send, so `send --kind answer` can pick the script up after the answer.
 * A paced run also stops before a step due later than `inlineWaitMs` from
 * now and keeps it for `next`. Returns the session the last message went
 * to, or undefined when the case stopped on a question.
 */
async function sendSteps(
  run: CaseRun,
  client: Client,
  steps: readonly PlannedStep[],
  options: {
    /** `next --early`: the first step goes now, whatever its «T+…». */
    readonly early: boolean;
    /** Files and voice notes of the whole run go with its first message. */
    readonly extrasOnFirst: boolean;
    readonly session: ClientSession | undefined;
  }
) {
  let { session } = options;
  const { settings } = run;
  run.deferred = undefined;
  for (const [index, step] of steps.entries()) {
    const dueAt = run.dueAt(step.at);
    const wait = dueAt.getTime() - Date.now();
    if (
      run.record.driver.paced &&
      wait > 0 &&
      !(options.early && index === 0)
    ) {
      if (wait > inlineWaitMs) {
        run.deferred = { at: step.at, dueAt };
        run.record.driver.remainingSteps = steps.slice(index).map(savedStep);
        return session;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- the log follows the script
      await run.journal.line(
        `== драйвер ждёт шаг «${step.at}» до ${isoWithOffset(dueAt, settings.timeZone)}`
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- a short «T+10мин» wait is kept in place
      await sleep(wait);
    }
    if (step.manual) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the log follows the script
      await run.journal.line(`   вручную (драйвер пропускает): ${step.manual}`);
    }
    const extras = options.extrasOnFirst && index === 0;
    // oxlint-disable-next-line eslint/no-await-in-loop -- a step reads its own files
    const message = await messageContent(
      step.text,
      [...step.files, ...(extras ? settings.extraFiles : [])],
      extras ? settings.voice : []
    );
    const opened = step.newConversation ? undefined : session;
    // oxlint-disable-next-line eslint/no-await-in-loop -- steps of one case are sequential
    session = await exchange(run, async (signal) => {
      if (opened) {
        await run.noteTurn(opened, "script", step.at, step.text);
        return {
          events: await opened.send(message, { signal }),
          session: opened,
        };
      }
      const created = await client.sessions.create({ message, signal });
      await run.noteTurn(created.session, "script", step.at, step.text);
      return { events: created.response, session: created.session };
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- steps of one case are sequential
    await settleInputs(run, session);
    run.record.driver.remainingSteps = steps.slice(index + 1).map(savedStep);
    if (run.tracker.blocked(run.settings.heldTools)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the case ends here
      await run.settle();
      return undefined;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- saved after every step so a crash keeps the transcript
    await run.save("completed");
  }
  return session;
}

/** Runs a planned case from its first message to a settled end. */
export async function runCase(
  client: Client,
  benchCase: BenchCase,
  steps: readonly PlannedStep[],
  scriptNotes: readonly string[],
  settings: DriverSettings
) {
  const journal = new CaseJournal(
    settings.outDir,
    benchCase.id,
    settings.timeZone
  );
  await journal.open();
  const run = new CaseRun(
    journal,
    newRecord(benchCase, settings, journal, steps, scriptNotes),
    settings
  );
  await journal.line(
    `=== ${benchCase.id}: ${benchCase.title} (${settings.host})`
  );
  if (scriptNotes.length > 0) {
    await journal.line(
      scriptNotes.map((note) => `   сценарий: ${note}`).join("\n")
    );
  }
  try {
    const session = await sendSteps(run, client, steps, {
      early: true,
      extrasOnFirst: true,
      session: undefined,
    });
    if (run.tracker.blocked(run.settings.heldTools)) return run.record;
    if (session) await finishBackground(run, session);
    await run.settle();
  } catch (error) {
    await failRun(
      run,
      error instanceof Error ? error : new Error(String(error))
    );
  }
  return run.record;
}

/**
 * A tester's message, card answer or code in a case's latest session. An
 * answer to the question the case stopped on also sends the rest of the
 * script: d13 and d15 used to end «completed» right after the answer, with
 * their later probes never sent.
 */
export async function continueCase(
  client: Client,
  record: RunRecord,
  settings: DriverSettings,
  input: {
    readonly kind: TesterTurnKind;
    readonly respond: (
      pending: readonly InputRequest[]
    ) => InputResponse[] | undefined;
    readonly text: string;
    readonly code: string | undefined;
  }
) {
  const journal = new CaseJournal(
    settings.outDir,
    record.caseId,
    settings.timeZone
  );
  if (input.code) journal.knownCodes.add(input.code);
  const run = new CaseRun(journal, record, settings);
  const cursor = record.driver.sessions.at(-1);
  if (!cursor) throw new Error(`${record.caseId} has no session to continue.`);
  const session = client.sessions.attach(cursor.sessionId, {
    streamIndex: cursor.streamIndex,
  });
  try {
    // Background events since the driver last looked; `send` would skip them.
    for await (const event of session.stream({ follow: false })) {
      await run.observe(session, event);
    }
    const responses = input.respond([...run.tracker.pending.values()]);
    await run.noteTurn(session, input.kind, "продолжение", input.text);
    if (responses) {
      await exchange(run, async (signal) => ({
        events: await session.respond(responses, { signal }),
        session,
      }));
    } else {
      const message = await messageContent(
        input.text,
        settings.extraFiles,
        settings.voice
      );
      await exchange(run, async (signal) => ({
        events: await session.send(message, { signal }),
        session,
      }));
    }
    await settleInputs(run, session);
    if (run.tracker.blocked(run.settings.heldTools)) {
      await run.settle();
      return run.record;
    }
    const remaining =
      input.kind === "answer" ? plannedSteps(record.driver.remainingSteps) : [];
    const last =
      remaining.length > 0
        ? await sendSteps(run, client, remaining, {
            early: false,
            extrasOnFirst: false,
            session,
          })
        : session;
    if (run.tracker.blocked(run.settings.heldTools)) return run.record;
    if (last) await finishBackground(run, last);
    await run.settle();
  } catch (error) {
    await failRun(
      run,
      error instanceof Error ? error : new Error(String(error))
    );
  }
  return run.record;
}

/** Catches up on a case's session and follows it for background results. */
export async function followCase(
  client: Client,
  record: RunRecord,
  settings: DriverSettings
) {
  const journal = new CaseJournal(
    settings.outDir,
    record.caseId,
    settings.timeZone
  );
  const run = new CaseRun(journal, record, settings);
  const cursor = record.driver.sessions.at(-1);
  if (!cursor) throw new Error(`${record.caseId} has no session to follow.`);
  const session = client.sessions.attach(cursor.sessionId, {
    streamIndex: cursor.streamIndex,
  });
  run.tracker.expectBackground();
  try {
    await awaitBackground(run, session);
    await run.settle();
  } catch (error) {
    await failRun(
      run,
      error instanceof Error ? error : new Error(String(error))
    );
  }
  return run.record;
}

/**
 * Sends the scripted steps that are due now — «T+7д» a week after the run
 * started — into the case's conversation, or into a new one where the
 * script says «новый разговор», and stops again before a step due later.
 * `early` sends the first remaining step at once.
 */
export async function nextCase(
  client: Client,
  record: RunRecord,
  settings: DriverSettings,
  options: { readonly early: boolean }
) {
  const steps = plannedSteps(record.driver.remainingSteps);
  if (steps.length === 0) {
    throw new Error(`${record.caseId}: every scripted step has been sent.`);
  }
  if (
    record.driver.pendingInputs.some((request) => request.kind === "question")
  ) {
    throw new Error(
      `${record.caseId}: Bro is waiting for the tester's answer first: pnpm bench send --kind answer --out ${settings.outDir} --case ${record.caseId} --text …`
    );
  }
  const journal = new CaseJournal(
    settings.outDir,
    record.caseId,
    settings.timeZone
  );
  const run = new CaseRun(journal, record, settings);
  const cursor = record.driver.sessions.at(-1);
  const session = cursor
    ? client.sessions.attach(cursor.sessionId, {
        streamIndex: cursor.streamIndex,
      })
    : undefined;
  const turnsBefore = record.driver.turns.length;
  try {
    if (session) {
      // Whatever Bro wrote since the driver last looked; `send` would skip it.
      for await (const event of session.stream({ follow: false })) {
        await run.observe(session, event);
      }
    }
    const last = await sendSteps(run, client, steps, {
      early: options.early,
      extrasOnFirst: false,
      session,
    });
    if (run.tracker.blocked(run.settings.heldTools)) return run.record;
    // Background errands are waited for only after a message went out.
    if (last && run.record.driver.turns.length > turnsBefore) {
      await finishBackground(run, last);
    }
    await run.settle();
  } catch (error) {
    await failRun(
      run,
      error instanceof Error ? error : new Error(String(error))
    );
  }
  return run.record;
}

/** Keeps what arrived: the time Bro sent it, by the tester's clock. */
function noteArrival(
  run: CaseRun,
  observation: {
    readonly at: Date;
    readonly channel: ObservationChannel;
    readonly sessionId: string | null;
    readonly text: string;
  }
) {
  const { timeZone } = run.settings;
  run.record.driver.observations.push({
    at: isoWithOffset(observation.at, timeZone),
    channel: observation.channel,
    night: isNight(observation.at, timeZone),
    sessionId: observation.sessionId,
    source: observation.sessionId === null ? "tester" : "stream",
    text: observation.text,
  });
}

/** A case's record to go on with, or a fresh one for a case only watched. */
async function observationRun(
  benchCase: BenchCase,
  existing: RunRecord | undefined,
  settings: DriverSettings,
  notes: readonly string[]
) {
  const journal = new CaseJournal(
    settings.outDir,
    benchCase.id,
    settings.timeZone
  );
  if (existing) return new CaseRun(journal, existing, settings);
  await journal.open();
  const run = new CaseRun(
    journal,
    newRecord(benchCase, settings, journal, [], notes),
    settings
  );
  await journal.line(
    `=== ${benchCase.id}: ${benchCase.title} (${settings.host}), наблюдение`
  );
  if (notes.length > 0) {
    await journal.line(notes.map((note) => `   сценарий: ${note}`).join("\n"));
  }
  return run;
}

/**
 * Watches a conversation for what Bro writes on its own — the flight of d10,
 * the evening of d11, the 8:00 digest of d12 — and sends nothing. Every
 * message is kept in `driver.observations` with the time Bro sent it, so a
 * night message shows as one. A session the driver has not read before is
 * read from `since`, not from its first message; one it has read goes on
 * from its cursor, so running `observe` again the next morning catches up.
 */
export async function observeCase(
  client: Client,
  benchCase: BenchCase,
  existing: RunRecord | undefined,
  settings: DriverSettings,
  options: {
    readonly channel: ObservationChannel;
    readonly durationMs: number;
    readonly notes: readonly string[];
    readonly sessionId: string | undefined;
    readonly since: Date;
  }
) {
  const run = await observationRun(
    benchCase,
    existing,
    settings,
    options.notes
  );
  const sessionId =
    options.sessionId ?? run.record.driver.sessions.at(-1)?.sessionId;
  if (!sessionId) {
    throw new Error(
      `${benchCase.id} has no conversation yet: name the one to watch with --session <id> (the id in /chat/<id>).`
    );
  }
  const known = run.record.driver.sessions.find(
    (cursor) => cursor.sessionId === sessionId
  );
  const session = client.sessions.attach(sessionId, {
    streamIndex: known?.streamIndex ?? 0,
  });
  run.attach(session);
  const until = new Date(Date.now() + options.durationMs);
  // A case with scripted steps still due stays `scheduled`: watching it
  // between steps must not hide what `next` has left to send.
  const { status: before, statusDetail: beforeDetail } = run.record.driver;
  const keepStatus =
    before === "scheduled" && run.record.driver.remainingSteps.length > 0;
  const saveWatch = () =>
    keepStatus
      ? run.save(before, beforeDetail)
      : run.save(
          "observing",
          `наблюдение до ${isoWithOffset(until, settings.timeZone)}, сообщений: ${String(run.record.driver.observations.length)}; продолжить: pnpm bench observe --out ${settings.outDir} --case ${benchCase.id}`
        );
  const see = async (event: MessageStreamEvent) => {
    await run.observe(session, event);
    const text = deliveredText(event);
    if (text === undefined) return;
    noteArrival(run, {
      at: new Date(event.meta.at),
      channel: options.channel,
      sessionId,
      text,
    });
    await saveWatch();
  };
  await run.journal.line(
    `== драйвер наблюдает за ${sessionId} до ${isoWithOffset(until, settings.timeZone)}, ничего не отправляя`
  );
  try {
    for await (const event of session.stream({
      follow: false,
      startIndex: known ? session.state.streamIndex : 0,
    })) {
      if (known || Date.parse(event.meta.at) >= options.since.getTime()) {
        await see(event);
      }
    }
    // A stream gives up after a few idle reconnects; it is reopened until
    // the watch ends.
    while (Date.now() < until.getTime()) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, until.getTime() - Date.now());
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one stream at a time, reopened in order
        for await (const event of session.stream({
          signal: controller.signal,
        })) {
          await see(event);
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        clearTimeout(timer);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- the cursor is kept after every reopen
      await saveWatch();
      // oxlint-disable-next-line eslint/no-await-in-loop -- a pause before reopening an idle stream
      if (!controller.signal.aborted) await sleep(1000);
    }
    await saveWatch();
  } catch (error) {
    await failRun(
      run,
      error instanceof Error ? error : new Error(String(error))
    );
  }
  return run.record;
}

/**
 * Records a message the tester saw in a messenger the driver cannot read
 * (`send --kind observed`): proactive messages go to the person's last
 * Telegram or iMessage chat, not to the web chat.
 */
export async function noteObservation(
  benchCase: BenchCase,
  existing: RunRecord | undefined,
  settings: DriverSettings,
  observation: {
    readonly at: Date;
    readonly channel: ObservationChannel;
    readonly notes: readonly string[];
    readonly text: string;
  }
) {
  const run = await observationRun(
    benchCase,
    existing,
    settings,
    observation.notes
  );
  noteArrival(run, { ...observation, sessionId: null });
  await run.journal.line(
    `== пришло в ${observation.channel} в ${isoWithOffset(observation.at, settings.timeZone)} (вставил тестировщик): ${observation.text}`
  );
  // A case only watched so far stays `observing`; any other keeps its state.
  await run.save(
    existing ? existing.driver.status : "observing",
    existing ? existing.driver.statusDetail : null
  );
  return run.record;
}
