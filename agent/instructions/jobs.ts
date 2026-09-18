import { defineDynamic, defineInstructions } from "eve/instructions";
import { turnAttributes } from "../lib/turn-attrs";
import { jobWakeRows, markNudged } from "../lib/convex";
import {
  dueJobNudges,
  isJobCheckWakeup,
  jobCheckPayload,
  jobWakeInstruction,
} from "../lib/job-wake.ts";
import { isShortAckTurn } from "../lib/short-ack.ts";
import { fastAckInstruction, fastAckOf } from "../lib/fast-ack.ts";
import { browserPollForceSpeak, turnOrigin } from "../lib/silent-turn.ts";
import { turnVoice, voiceInstruction } from "../lib/turn-voice.ts";
import { nudgePrompt, type WaitingFor } from "../../convex/lib/jobNudgePolicy.ts";
import { tenantId } from "../lib/tenant";
import { latencyFields } from "../lib/latency-log.ts";
import { getTenant } from "../lib/convex";
import {
  cloudInjectInstruction,
  cloudInjectKindFromAttrs,
  cloudSessionLooksLive,
  cloudStartInFlight,
} from "../../convex/lib/browserInjectPolicy.ts";

export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      try {
        const phone = tenantId(ctx);
        const attrs = turnAttributes(ctx);
        console.log("turn started", latencyFields(attrs));
        const rows = await jobWakeRows(phone);
        const now = Date.now();
        const jobCheck = isJobCheckWakeup(attrs);
        const scope = jobCheck ? { payload: jobCheckPayload(attrs) } : undefined;
        const due = scope ? dueJobNudges(rows, now, scope) : [];
        if (due.length > 0) {
          void Promise.all(
            due.map((job) =>
              markNudged(phone, job.id).catch((err) =>
                console.error("markNudged failed", err),
              ),
            ),
          );
        }
        // Speak-or-stay-quiet is decided ONCE, by `turnVoice`, and injected as
        // exactly one line. It used to be four competing lines whose winner
        // depended on the order of this array — the nudge copy even carried
        // «Ignore any later line that allows [SILENT]» to survive the clash.
        const verdict = turnVoice({
          origin: turnOrigin(attrs),
          shortAck: isShortAckTurn(attrs),
          waitingForHuman: rows.some((row) => row.waitingFor === "human"),
          jobCheck,
          dueNudges: due.length,
          browserPollForceSpeak: browserPollForceSpeak(attrs),
        });
        const voice = voiceInstruction(verdict, {
          nudges: due.map((job) =>
            nudgePrompt({
              waitingFor: job.waitingFor as WaitingFor,
              goal: job.goal,
              note: job.note,
            }),
          ),
        });
        const fastAck = attrs?.origin === "human" ? fastAckOf(attrs) : null;
        const injectKind =
          !jobCheck && verdict !== "ack_only"
            ? cloudInjectKindFromAttrs(attrs)
            : null;
        let inject: string | null = null;
        if (injectKind) {
          const tenant = await getTenant(phone).catch(() => null);
          inject = cloudInjectInstruction(
            injectKind,
            cloudSessionLooksLive({
              status: tenant?.browserStatus,
              sessionId: tenant?.browserSessionId,
              runId: tenant?.browserRunId,
              startedAt: tenant?.browserStartedAt,
              storedTask: tenant?.browserTask,
              // `browserNeed` doesn't exist on the schema yet (added by a
              // parallel package) — read it defensively.
              need: (tenant as { browserNeed?: string } | null)?.browserNeed,
            }) ||
              // An errand whose start is still in flight has no session id to
              // look live yet, and that is exactly the second in which the
              // follow-up («на воскресенье») arrives — without this the model
              // gets no «ввожу» instruction for it and treats it as chat.
              cloudStartInFlight({ startingAt: tenant?.browserStartingAt }),
          );
        }
        const content = [
          jobWakeInstruction(rows.map((r) => r.line)),
          voice,
          fastAck ? fastAckInstruction(fastAck) : null,
          inject,
        ]
          .filter((part): part is string => Boolean(part))
          .join("\n\n");
        if (!content) return null;
        return defineInstructions({ role: "system", content });
      } catch (err) {
        return defineInstructions({
          role: "system",
          content: `Job store unavailable: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  },
});
