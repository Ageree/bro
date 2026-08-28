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
export default crons;
