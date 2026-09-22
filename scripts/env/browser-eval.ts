import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const browserEvalEnv = createEnv({
  experimental__runtimeEnv: {},
  server: {
    BROWSER_USE_API_KEY: z.string().trim().min(1).optional(),
    DATABASE_URL: z.string().trim().min(1).optional(),
  },
});

export function prepareBrowserEvalEnvironment() {
  if (browserEvalEnv.DATABASE_URL === undefined) {
    process.env.DATABASE_URL = "postgresql://browser-eval.invalid/browser_eval";
  }
}
