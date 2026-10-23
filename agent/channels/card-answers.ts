import { defineChannel, POST } from "eve/channels";
import { resumeCardAnswers } from "@agent/lib/cards/answers";
import { cardAnswersPath } from "@shared/cards/routes";
import { env } from "@shared/environment";

/**
 * Where a card's page asks, once the person's answer is kept
 * (`app/api/cards/[id]/respond`), for the answers that wait to become a
 * turn of their chat now rather than at the next minute's tick
 * (`agent/schedules/cards.ts`). It takes nothing and tells nothing: only
 * answers the page already checked and kept go, each once, so anyone may
 * ask. No conversation starts here.
 */
export default defineChannel({
  audience() {
    return "unknown";
  },
  receive() {
    throw new Error("The card answers channel only serves its route.");
  },
  routes: [
    POST(cardAnswersPath, async (_request, { to, waitUntil }) => {
      if (
        env.DATABASE_DRIVER === "neon-http" ||
        (env.CARDS_WORKSPACES ?? []).length === 0
      ) {
        return new Response(null, { status: 404 });
      }
      waitUntil(resumeCardAnswers({ to }, new Date()));
      return await Promise.resolve(
        new Response(null, {
          headers: { "cache-control": "no-store" },
          status: 202,
        })
      );
    }),
  ],
});
