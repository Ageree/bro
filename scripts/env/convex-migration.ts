import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Environment the Convex import reads on top of the application's own. The old
 * deployment's vault master key is optional here because `--skip-vault` is a
 * supported way to run the import; the vault step validates it when it needs it.
 */
export const convexMigrationEnv = createEnv({
  server: {
    BRO_VAULT_KEY: z.string().optional(),
  },
  experimental__runtimeEnv: {},
});

/**
 * Points the shared Drizzle client at Neon's HTTP driver. It has to run before
 * anything imports `@db`, which is why the migration entry point selects the
 * driver and only then loads the services.
 */
export function selectNeonHttpDriver() {
  // oxlint-disable-next-line turbo/no-undeclared-env-vars -- This CLI sets the driver for its own process; no Turbo task reads it.
  process.env.DATABASE_DRIVER = "neon-http";
}
