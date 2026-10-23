import { defineSchedule } from "eve/schedules";
import { resumeCardAnswers } from "@agent/lib/cards/answers";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { env } from "@shared/environment";

/**
 * Each minute: the answers people gave on cards' pages that have not become
 * a turn of their chat yet. The page asks for this at once
 * (`agent/channels/card-answers.ts`); the tick takes what that missed — a
 * page closed before it asked, a send that failed — and gives up on an
 * answer after its third attempt.
 */
export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    if (!schedulesEnabled()) return;
    if (env.DATABASE_DRIVER === "neon-http") return;
    if ((env.CARDS_WORKSPACES ?? []).length === 0) return;
    waitUntil(resumeCardAnswers({ to }, new Date()));
  },
});
