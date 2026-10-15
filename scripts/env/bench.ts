import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * What the benchmark driver reads besides its command line. Every value can
 * also be passed as a flag; the variables exist so a long session sets them
 * once. The one-time sign-in code is deliberately not here: it is passed per
 * command, so it never sits in an environment that logs or child processes
 * could echo.
 */
export const benchEnv = createEnv({
  emptyStringAsUndefined: true,
  experimental__runtimeEnv: {},
  server: {
    BENCH_COOKIE_FILE: z.string().trim().min(1).optional(),
    /**
     * Where `scripts/bench/files/fixtures.py` builds the f-* suite's input
     * files and truth; `~/.bro-bench/files-fixtures` by default,
     * `--files-fixtures` overrides it.
     */
    BENCH_FILES_FIXTURES: z.string().trim().min(1).optional(),
    BENCH_HOST: z.url().default("https://brobro.tech"),
    BENCH_OUT_DIR: z.string().trim().min(1).optional(),
    BENCH_PHONE: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/u, "BENCH_PHONE must use E.164 format")
      .optional(),
    /**
     * The Python that builds the f-* fixtures and runs their checks: a venv
     * with the sandbox pins and `scripts/bench/files/requirements.txt`.
     */
    BENCH_PYTHON: z.string().trim().min(1).default("python3"),
    BENCH_TESTER: z.string().trim().min(1).default("драйвер"),
    BENCH_TIMEZONE: z.string().trim().min(1).default("Europe/Moscow"),
    /**
     * `fixtures seed` and `clean` reach the tester's Google account through
     * Composio's proxy with this key; nothing else in the driver needs it.
     */
    COMPOSIO_API_KEY: z.string().trim().min(1).optional(),
  },
});
