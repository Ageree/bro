import type { InputRequest, MessageStreamEvent } from "eve/client";
import { z } from "zod";
import { isBackgroundTurnText } from "@shared/chat/background-turn";
import type { DriverStatus } from "./journal.ts";

// `browser_task` answers `running` for an errand that continues in the
// background, or `queued` when every cloud browser is busy; either reports
// later as a new message in the same session. A follow-up names the run it
// replaces, and `status` follows an errand to its newest run.
const browserOutputSchema = z.object({
  output: z.object({
    previousRunId: z.string().min(1).optional(),
    runId: z.string().min(1),
    status: z.string(),
  }),
  toolName: z.literal("browser_task"),
});

const browserCallSchema = z.object({
  callId: z.string().min(1),
  input: z.object({ runId: z.string().min(1).optional() }),
  kind: z.literal("tool-call"),
  toolName: z.literal("browser_task"),
});

const backgroundStatuses = new Set(["queued", "running"]);

/**
 * A run in one of these states sends no report later: it was cancelled, or
 * `status` handed its outcome to the turn that asked.
 */
const settledStatuses = new Set([
  "cancelled",
  "completed",
  "failed",
  "stopped",
]);

/**
 * The message an errand's outcome arrives as: Bro's own prompt, opening with
 * the background-turn marker (`agent/lib/browser-use/completion.ts`).
 */
const browserReportPattern = /^Browser run (\S+) finished\./mu;

/**
 * What a conversation's stream says about where it stands: cards waiting
 * for an answer, an authorization Bro is parked on, and the browser errands
 * still due to report. The driver decides its next move from it.
 *
 * Only an errand's report settles it. A turn the tester or a nudge started
 * says nothing about the errands, even when Bro answers «ещё ищу».
 */
export class TurnTracker {
  readonly pending = new Map<string, InputRequest>();
  authorizationPending = false;
  productVersion: string | undefined;
  /** Errands due to report, oldest first. */
  readonly #runs: Set<string>;
  /** `browser_task` calls in flight: the run each one named. */
  readonly #calls = new Map<string, string>();
  #expectReport = false;

  constructor(
    pending: readonly InputRequest[] = [],
    backgroundRuns: readonly string[] = []
  ) {
    for (const request of pending) this.pending.set(request.requestId, request);
    this.#runs = new Set(backgroundRuns);
  }

  observe(event: MessageStreamEvent) {
    switch (event.type) {
      case "session.started": {
        const runtime = event.data.runtime;
        if (runtime) {
          const commit = runtime.build?.gitSha;
          this.productVersion = commit
            ? `${commit} (eve ${runtime.eveVersion})`
            : `eve ${runtime.eveVersion}`;
        }
        break;
      }
      case "message.received": {
        const report = event.data.kind
          ? undefined
          : this.#reportedRun(event.data.message);
        if (report !== undefined) this.#settleReport(report);
        break;
      }
      case "actions.requested": {
        for (const action of event.data.actions) {
          const call = browserCallSchema.safeParse(action);
          if (call.success && call.data.input.runId) {
            this.#calls.set(call.data.callId, call.data.input.runId);
          }
        }
        break;
      }
      case "action.result": {
        const requested = this.#calls.get(event.data.result.callId);
        this.#calls.delete(event.data.result.callId);
        const result = browserOutputSchema.safeParse(event.data.result);
        if (event.data.status !== "completed" || !result.success) break;
        const { previousRunId, runId, status } = result.data.output;
        if (backgroundStatuses.has(status)) {
          // The errand lives on under this id; the one it replaces or
          // was retried from will not report.
          for (const replaced of [previousRunId, requested]) {
            if (replaced !== undefined && replaced !== runId) {
              this.#runs.delete(replaced);
            }
          }
          this.#runs.add(runId);
        } else if (settledStatuses.has(status)) {
          this.#runs.delete(runId);
          if (requested !== undefined) this.#runs.delete(requested);
        }
        break;
      }
      case "input.requested": {
        for (const request of event.data.requests) {
          this.pending.set(request.requestId, request);
        }
        break;
      }
      case "input.resolved": {
        for (const resolution of event.data.resolutions) {
          this.pending.delete(resolution.requestId);
        }
        break;
      }
      case "authorization.required": {
        this.authorizationPending = true;
        break;
      }
      case "authorization.completed": {
        this.authorizationPending = false;
        break;
      }
      default: {
        break;
      }
    }
  }

  /** Whether a browser errand this conversation started has yet to report. */
  awaitingBackground() {
    return this.#expectReport || this.#runs.size > 0;
  }

  /** The errands still due to report, for the run record. */
  backgroundRuns() {
    return [...this.#runs];
  }

  /**
   * Follow a session for its errands (`pnpm bench follow`); with none on
   * record, as if one were running, until the next report.
   */
  expectBackground() {
    if (this.#runs.size === 0) this.#expectReport = true;
  }

  #reportedRun(message: string) {
    if (!isBackgroundTurnText(message)) return undefined;
    return browserReportPattern.exec(message)?.[1];
  }

  /**
   * A report settles its run. One for a run the driver never saw is an
   * errand retried in the background after an anti-bot check, or a queued
   * one that got its browser: it settles the oldest errand still due.
   */
  #settleReport(runId: string) {
    this.#expectReport = false;
    if (this.#runs.delete(runId)) return;
    const [oldest] = this.#runs;
    if (oldest !== undefined) this.#runs.delete(oldest);
  }

  /**
   * Why the driver cannot go on by itself, once the turn has settled: a
   * consent screen only a person can pass, a question only the tester can
   * answer, or an approval card of a `--hold`-ed tool that only the owner
   * decides (real purchases on prod).
   */
  blocked(
    heldTools: readonly string[] = []
  ): readonly [DriverStatus, string] | undefined {
    if (this.authorizationPending) {
      return [
        "needs-authorization",
        "Бро ждёт входа по ссылке (OAuth); драйвер его не проходит",
      ];
    }
    const questions = [...this.pending.values()].filter(
      (request) => request.kind === "question"
    );
    if (questions.length > 0) {
      return [
        "waiting-for-tester",
        `вопрос: ${questions.map((request) => request.prompt).join(" | ")}`,
      ];
    }
    const held = [...this.pending.values()].filter(
      (request) =>
        request.kind === "tool-approval" &&
        heldTools.includes(request.action.toolName)
    );
    if (held.length > 0) {
      return [
        "waiting-for-tester",
        `карточка на удержании — ${held
          .map((request) => `«${request.action.toolName}»: ${request.prompt}`)
          .join(" | ")}`,
      ];
    }
    return undefined;
  }
}
