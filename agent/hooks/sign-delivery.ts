import { defineHook } from "eve/hooks";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { deliveryVerdict } from "@agent/lib/signatures/consent";
import { signOfCaller } from "@agent/lib/signatures/pilot";
import {
  clearSigningAsked,
  markSigningAsked,
  markSigningShown,
  openSignings,
} from "@db/services/signatures/signings";

/**
 * Notes on each open signing of the conversation what Bro's delivered sends
 * did (SIGN_WORKSPACES): the unsigned file reached the person (`shown_at`),
 * the signing question was asked and in which turn (`asked_*`), or a later
 * question took its place. `sign_document confirm` reads only these: the
 * record outlives a compaction, a restart and the steps of a split reply.
 * eve drains a step's hooks before the step ends, so the record is there
 * before the person's next turn. A send that was skipped or refused does not
 * parse as delivered and changes nothing.
 */
export default defineHook({
  events: {
    async "action.result"(event, ctx) {
      if (event.data.status !== "completed" || ctx.session.parent) return;
      const sent = sendMessageToolResultSchema.safeParse(
        event.data.result
      ).data;
      const caller = ctx.session.auth.current;
      if (
        sent === undefined ||
        caller?.principalType !== "user" ||
        !signOfCaller(ctx)
      ) {
        return;
      }
      const turn = `${ctx.session.id}\n${ctx.session.turn.id}`;
      try {
        const rows = await openSignings(
          scopeFromPrincipal(caller),
          ctx.session.id
        );
        for (const row of rows) {
          const { asked, shown } = deliveryVerdict(row, sent.output);
          /* oxlint-disable eslint/no-await-in-loop -- A few rows, one statement each. */
          if (shown) await markSigningShown(row.id);
          if (asked === "clear") await clearSigningAsked(row.id);
          else if (asked !== undefined) {
            await markSigningAsked(row.id, { ...asked, turn });
          }
          /* oxlint-enable eslint/no-await-in-loop */
        }
      } catch (error) {
        console.warn("[sign] delivery not noted", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    },
  },
});
