import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

/**
 * End-to-end runs against real clouds, kept out of `pnpm check`: nothing of
 * `tests/setup-env.ts` (which shuts every key and the network out) applies,
 * and each file brings its own settings. The browser pool's run is
 * documented in docs/browser-pool.md, section 10.
 */
export default defineConfig({
  resolve: base.resolve,
  test: {
    fileParallelism: false,
    hookTimeout: 30 * 60_000,
    include: ["tests/e2e/**/*.e2e.ts"],
    testTimeout: 2 * 60 * 60_000,
  },
});
