import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("dispatch wakeups", { seconds: 60 }, internal.wakeups.dispatchDue, {});
export default crons;
