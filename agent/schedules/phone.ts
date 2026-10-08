import { defineSchedule } from "eve/schedules";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { env } from "@shared/environment";
import {
  acknowledgePhoneEvents,
  expirePlannedPhoneCall,
  listPhonePolls,
  prunePhoneData,
  updatePhoneCall,
} from "@db/services/phone";
import { findConversation, readConversation } from "@shared/phone/elevenlabs";
import { deliverPhoneReports } from "@agent/lib/phone/report";
import { provisionNewWorkspacePhones } from "@db/services/phone/lifecycle";

export default defineSchedule({
  cron: "* * * * *",
  run({ attachSession, to, waitUntil }) {
    if (
      !schedulesEnabled() ||
      !env.ELEVENLABS_API_KEY ||
      !env.PHONE_AGENT_ID ||
      env.DATABASE_DRIVER === "neon-http"
    )
      return;
    waitUntil(
      provisionNewWorkspacePhones()
        .then(() => reconcile())
        .then(() => deliverPhoneReports({ attachSession, to }))
        .catch(() => {
          console.warn("[phone] reconciliation unavailable");
        })
    );
  },
});

async function reconcile() {
  await prunePhoneData();
  const rows = await listPhonePolls();
  await Promise.all(
    rows.map(async ({ call, number }) => {
      const overdue = Date.now() - call.createdAt.getTime() > 30 * 60_000;
      try {
        if (call.state === "planned") {
          if (Date.now() - call.createdAt.getTime() > 5 * 60_000)
            await expirePlannedPhoneCall(call.id);
          return;
        }
        const conversationId =
          call.providerConversationId ?? (await findConversation(call.id));
        if (!conversationId) {
          if (overdue)
            await updatePhoneCall(call.id, {
              state: "uncertain",
              outcome: "acceptance_unknown",
              summary:
                "Provider acceptance could not be reconciled. No automatic retry was made; cost and outcome are unknown and budget remains reserved.",
              completedAt: new Date(),
            });
          return;
        }
        const remote = await readConversation(conversationId);
        const terminal = remote.status === "done" || remote.status === "failed";
        const mismatch =
          remote.conversationId !== conversationId ||
          remote.agentId !== number.agentId ||
          (remote.phoneNumberId !== null &&
            remote.phoneNumberId !==
              (call.direction === "outbound"
                ? number.outboundPhoneNumberId
                : number.phoneNumberId)) ||
          (call.direction === "outbound" &&
            remote.localCallId !== null &&
            remote.localCallId !== call.id);
        if (
          mismatch ||
          (terminal &&
            (remote.phoneNumberId === null ||
              (call.direction === "outbound" &&
                remote.localCallId !== call.id)))
        ) {
          if (overdue)
            await updatePhoneCall(call.id, {
              state: "uncertain",
              outcome: "mapping_unverified",
              summary:
                "Provider conversation mapping could not be verified. No transcript or result was accepted; cost and task outcome remain unknown.",
              completedAt: new Date(),
            });
          return;
        }
        const ready =
          terminal &&
          (remote.summary !== null || remote.status === "failed" || overdue);
        await updatePhoneCall(call.id, {
          providerConversationId: conversationId,
          state: ready
            ? remote.status
            : terminal
              ? "processing"
              : remote.status,
          durationSeconds:
            remote.durationSeconds === null
              ? null
              : Math.ceil(remote.durationSeconds),
          costUsd: remote.costUsd === null ? null : String(remote.costUsd),
          carrierRub: remote.carrierRub,
          outcome:
            remote.outcome?.slice(0, 500) ?? (ready ? remote.status : null),
          taskSucceeded: remote.taskSucceeded,
          summary:
            remote.summary?.slice(0, 6000) ??
            (ready
              ? "The provider ended the call but did not supply a summary. Task success is not established."
              : null),
          completedAt: ready ? new Date() : undefined,
        });
        await acknowledgePhoneEvents(conversationId);
        if (overdue && !ready && remote.status !== "active")
          await updatePhoneCall(call.id, {
            state: "uncertain",
            outcome: "provider_timeout",
            summary:
              "The provider did not deliver a final verified result within 30 minutes. No retry was made; task success and final charges remain unknown.",
            completedAt: new Date(),
          });
      } catch {
        if (overdue)
          await updatePhoneCall(call.id, {
            state: "uncertain",
            outcome: "reconciliation_unavailable",
            summary:
              "Provider reconciliation was unavailable; no call was repeated and final charges remain unknown.",
            completedAt: new Date(),
          });
      }
    })
  );
}
