import { defineApp } from "convex/server";
import crons from "@convex-dev/crons/convex.config.js";

const app = defineApp();
app.use(crons);
export default app;
