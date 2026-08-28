import { defineApp } from "convex/server";
import crons from "@convex-dev/crons/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";
import workflow from "@convex-dev/workflow/convex.config.js";

const app = defineApp();
app.use(crons);
app.use(rateLimiter);
app.use(workflow);
export default app;
