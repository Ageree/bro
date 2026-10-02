/**
 * The database steps of a release on the Cloud.ru VM, run by deployd before
 * it switches `current` (scripts/cloudru-app-host/README.md). The VM has no
 * pnpm and no drizzle-kit: `host.py build` bundles this file into
 * `ops/migrate.mjs` of the release, next to the SQL it applies.
 *
 *   node ops/migrate.mjs app     Bro's migrations (db/migrations) into
 *                                DATABASE_URL_UNPOOLED, else DATABASE_URL
 *   node ops/migrate.mjs world   the schema of @workflow/world-postgres and
 *                                its graphile-worker queue into
 *                                WORKFLOW_POSTGRES_URL
 *
 * Both are what `pnpm db:migrate` and the world's own `bootstrap` CLI do,
 * with the same migration tables, so either may run against a database the
 * other prepared. Each is idempotent. Nothing here prints a connection string.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { makeWorkerUtils } from "graphile-worker";
import { Pool } from "pg";

const release = join(dirname(fileURLToPath(import.meta.url)), "..");

// A connection to Cloud.ru's managed PostgreSQL once hung for two minutes and
// dropped ("Connection terminated unexpectedly"); the same step a moment later
// took half a second. Both steps are idempotent, so one that lost its
// connection runs once more, and a connect that does not answer counts as lost.
const connectTimeoutMs = 20_000;
const lostConnection =
  /Connection terminated|timeout exceeded when trying to connect|ECONNRESET|ETIMEDOUT/u;

function connection(...names: string[]) {
  // oxlint-disable-next-line eslint/no-restricted-properties -- a one-shot CLI on the VM with the env of /etc/bro/env, not the app: env.ts would demand every app setting
  const environment = process.env;
  const value = names
    .map((name) => environment[name]?.trim())
    .find((found) => found !== undefined && found.length > 0);
  if (value === undefined) throw new Error(`${names.join(" or ")} is not set`);
  return value;
}

async function migrateApp() {
  const pool = new Pool({
    connectionString: connection("DATABASE_URL_UNPOOLED", "DATABASE_URL"),
    connectionTimeoutMillis: connectTimeoutMs,
    max: 1,
  });
  try {
    // drizzle-kit's defaults: schema `drizzle`, table `__drizzle_migrations`.
    await migrate(drizzle(pool), {
      migrationsFolder: join(release, "db", "migrations"),
    });
  } finally {
    await pool.end();
  }
}

async function migrateWorld() {
  const pool = new Pool({
    connectionString: connection("WORKFLOW_POSTGRES_URL"),
    connectionTimeoutMillis: connectTimeoutMs,
    max: 1,
  });
  try {
    // The tables the world's `bootstrap` CLI keeps its journal in
    // (node_modules/@workflow/world-postgres/dist/cli.js).
    await migrate(drizzle(pool), {
      migrationsFolder: join(release, "ops", "world-migrations"),
      migrationsSchema: "workflow_drizzle",
      migrationsTable: "workflow_migrations",
    });
    // The queue's schema too, before eve starts: installing it on start is
    // not safe against a second starter.
    const worker = await makeWorkerUtils({ pgPool: pool });
    try {
      await worker.migrate();
    } finally {
      await worker.release();
    }
  } finally {
    await pool.end();
  }
}

async function timed(name: string, step: () => Promise<void>) {
  const started = Date.now();
  try {
    await step();
  } catch (error) {
    if (!(error instanceof Error) || !lostConnection.test(error.message)) {
      throw error;
    }
    console.log(`migrate ${name}: lost the connection, once more`);
    await step();
  }
  console.log(`migrate ${name}: done in ${String(Date.now() - started)} ms`);
}

const wanted = process.argv.slice(2);
if (
  wanted.length === 0 ||
  wanted.some((name) => name !== "app" && name !== "world")
) {
  console.error("usage: node ops/migrate.mjs app|world ...");
  process.exit(2);
}
// Bro's tables first: the world's schema is the one a release can do without.
if (wanted.includes("app")) await timed("app", migrateApp);
if (wanted.includes("world")) await timed("world", migrateWorld);
