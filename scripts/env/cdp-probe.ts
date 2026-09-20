import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * What the browser probes read on top of the application's own environment.
 *
 * The Browser Use key is optional because the cloud probe skips rather than
 * fails without one: it spends real money, so having a key configured at all is
 * what opts into it. The ports exist so a probe can run beside a development
 * server that already holds the usual ones.
 */
export const cdpProbeEnv = createEnv({
  experimental__runtimeEnv: {},
  server: {
    BROWSER_USE_API_KEY: z.string().trim().min(1).optional(),
    CDP_PROBE_DEBUG_PORT: z.coerce.number().int().positive().default(9222),
    CDP_PROBE_PORT: z.coerce.number().int().positive().default(8899),
    CHROME_PATH: z.string().trim().min(1).optional(),
  },
});
