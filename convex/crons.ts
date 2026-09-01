import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
// ponytail: each wakeup has its own @convex-dev/crons one-shot at `at`.
// this 15m sweep only recovers orphans (lost component cron / pre-migration rows)
crons.interval(
  "pickup overdue wakeups",
  { minutes: 15 },
  internal.wakeups.dispatchDue,
  {},
);
// Instinct-style memory: copy each person's connected-app data into their
// Supermemory archive. The eve route skips people without connections.
crons.interval(
  "sync connected-app archives",
  { hours: 1 },
  internal.archive.dispatchSyncs,
  {},
);
// Drop composioEvents older than EVENT_TTL_MS so the dedupe table stays bounded.
crons.interval("prune composio events", { hours: 24 }, internal.watchers.pruneEvents, {});
export default crons;
