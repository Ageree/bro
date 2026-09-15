import { defineDynamic, defineInstructions } from "eve/instructions";
import { isGroupTurn, turnAttributes } from "../lib/group-guard";
import { jobWakeRows, markNudged } from "../lib/convex";
import {
  dueJobNudges,
  isJobCheckWakeup,
  jobCheckPayload,
  JOB_CHECK_QUIET,
  jobNudgeInstruction,
  jobWakeInstruction,
} from "../lib/job-wake.ts";
import { isShortAckTurn, shortAckInstruction } from "../lib/short-ack.ts";
import { fastAckInstruction, fastAckOf } from "../lib/fast-ack.ts";
import { browserPollForceSpeak } from "../lib/silent-turn.ts";
import { tenantId } from "../lib/tenant";
import { latencyFields } from "../lib/latency-log.ts";
import { getTenant } from "../lib/convex";
import {
  cloudInjectInstruction,
  cloudInjectKindFromAttrs,
  cloudSessionLooksLive,
} from "../../convex/lib/browserInjectPolicy.ts";

export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      if (isGroupTurn(ctx)) {
        return defineInstructions({
          role: "system",
          content:
            "Group turn. Do not inject or mention this person's private open jobs.",
        });
      }
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
        const ack =
          !jobCheck && isShortAckTurn(attrs)
            ? shortAckInstruction({
                waitingForHuman: rows.some((row) => row.waitingFor === "human"),
              })
            : null;
        const fastAck = attrs?.origin === "human" ? fastAckOf(attrs) : null;
        const injectKind =
          !jobCheck && !ack ? cloudInjectKindFromAttrs(attrs) : null;
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
            }),
          );
        }
        const forceSpeak = browserPollForceSpeak(attrs);
        const content = [
          jobWakeInstruction(rows.map((r) => r.line)),
          scope
            ? due.length > 0
              ? jobNudgeInstruction(due)
              : JOB_CHECK_QUIET
            : null,
          ack,
          fastAck ? fastAckInstruction(fastAck) : null,
          inject,
          forceSpeak
            ? "Do NOT answer [SILENT]; the human must get one message about this browser errand now."
            : null,
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
