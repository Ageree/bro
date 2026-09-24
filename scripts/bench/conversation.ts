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
import {
  CaseJournal,
  isoWithOffset,
  type DriverStatus,
  type RunRecord,
  type TesterTurnKind,
} from "./journal.ts";
import { messageContent, type OutgoingFile } from "./media.ts";
import type { PlannedStep } from "./steps.ts";
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
  readonly extraFiles: readonly OutgoingFile[];
  readonly hintText: string;
  readonly host: string;
  /** Follow-and-ask rounds while a background errand stays silent. */
  readonly nudges: number;
  readonly outDir: string;
  readonly tester: string;
  readonly timeZone: string;
  /** Upper bound for one turn, approvals included. */
  readonly turnTimeoutMs: number;
  readonly voice: readonly string[];
}

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
    this.tracker = new TurnTracker(record.driver.pendingInputs);
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

  /** Saves where the case ended: blocked on a person, or done. */
  async settle() {
    const blocked = this.tracker.blocked();
    await (blocked
      ? this.save(blocked[0], blocked[1])
      : this.save("completed"));
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
}

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
      const decision = decideInputRequest(request, run.settings.approvedTools);
      if (decision.kind !== "respond") continue;
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
    if (run.tracker.blocked()) break;
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
    if (round === run.settings.nudges || run.tracker.blocked()) return;
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
      decisions: [],
      fixtures: steps.flatMap((step) =>
        step.files.map((file) => ({ file: file.path, shows: file.shows }))
      ),
      host: settings.host,
      pendingInputs: [],
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
  let session: ClientSession | undefined;
  try {
    for (const [index, step] of steps.entries()) {
      if (step.manual) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the log follows the script
        await journal.line(`   вручную (драйвер пропускает): ${step.manual}`);
      }
      const first = index === 0;
      // oxlint-disable-next-line eslint/no-await-in-loop -- a step reads its own files
      const message = await messageContent(
        step.text,
        [...step.files, ...(first ? settings.extraFiles : [])],
        first ? settings.voice : []
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
      if (run.tracker.blocked()) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the case ends here
        await run.settle();
        return run.record;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- saved after every step so a crash keeps the transcript
      await run.save("completed");
    }
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

/** A tester's message, card answer or code in a case's latest session. */
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
    if (!run.tracker.blocked()) await finishBackground(run, session);
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
