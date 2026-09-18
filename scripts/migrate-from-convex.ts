import { selectNeonHttpDriver } from "./env/convex-migration.ts";
import { registerApplicationModuleResolution } from "./lib/module-resolution.ts";

/**
 * Imports the previous product's Convex snapshot into this installation.
 *
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/migrate-from-convex.ts --export <dir> \
 *     [--dry-run] [--only +7900...] [--register-photon] [--via-neon-http] \
 *     [--skip-vault]
 *
 * Nothing from the application is imported at the top of this file on purpose:
 * the database driver has to be chosen, and TypeScript path resolution has to
 * be installed, before the first `@db` import builds the client.
 */
const usage =
  "Usage: node --env-file=.env.local --experimental-strip-types scripts/migrate-from-convex.ts --export <dir> [--dry-run] [--only +7900...] [--register-photon] [--via-neon-http] [--skip-vault]";

const commandLine = process.argv.slice(2);
const viaNeonHttp = commandLine.includes("--via-neon-http");
if (viaNeonHttp) selectNeonHttpDriver();
registerApplicationModuleResolution();

const { migrateFromConvex, parseMigrationArguments } =
  await import("./lib/migrate-from-convex.ts");

try {
  const summary = await migrateFromConvex(parseMigrationArguments(commandLine));
  if (summary.failed > 0) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error(usage);
  process.exitCode = 1;
} finally {
  // The pooled TCP driver holds the process open; the HTTP driver has nothing
  // to close.
  if (!viaNeonHttp) {
    const { db } = await import("@db");
    await db.$client.end();
  }
}
