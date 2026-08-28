import { defineApp } from "convex/server";
import crons from "@convex-dev/crons/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";

const app = defineApp();
app.use(crons);
app.use(rateLimiter);

export default app;
