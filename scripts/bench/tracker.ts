import type { InputRequest, MessageStreamEvent } from "eve/client";
import { z } from "zod";
import type { DriverStatus } from "./journal.ts";

// `browser_task` answers `running` for an errand that continues in the
// background and reports later as a new message in the same session.
const browserRunningSchema = z.object({
  output: z.object({ status: z.literal("running") }),
  toolName: z.literal("browser_task"),
});

/**
 * What a conversation's stream says about where it stands: cards waiting
 * for an answer, an authorization Bro is parked on, and whether a browser
 * errand is still due to report. The driver decides its next move from it.
 */
export class TurnTracker {
  readonly pending = new Map<string, InputRequest>();
  authorizationPending = false;
  productVersion: string | undefined;
  #awaitingBackground = false;
  #runningInTurn = false;

  constructor(pending: readonly InputRequest[] = []) {
    for (const request of pending) this.pending.set(request.requestId, request);
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
      case "turn.started": {
        this.#runningInTurn = false;
        break;
      }
      case "action.result": {
        if (
          event.data.status === "completed" &&
          browserRunningSchema.safeParse(event.data.result).success
        ) {
          this.#awaitingBackground = true;
          this.#runningInTurn = true;
        }
        break;
      }
      case "turn.completed":
      case "turn.failed": {
        // A turn that started no new errand has delivered (or dropped) the
        // result the case was waiting for.
        if (!this.#runningInTurn) this.#awaitingBackground = false;
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
    return this.#awaitingBackground;
  }

  /** Follow a session as if an errand were running (`pnpm bench follow`). */
  expectBackground() {
    this.#awaitingBackground = true;
  }

  /**
   * Why the driver cannot go on by itself, once the turn has settled: a
   * consent screen only a person can pass, or a question only the tester
   * can answer.
   */
  blocked(): readonly [DriverStatus, string] | undefined {
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
    return undefined;
  }
}
