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
 *   node ops/migrate.mjs unlock  the queue jobs a stopped eve still holds,
 *                                back to the queue (bro-eve.service, before
 *                                every start)
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
// connection runs once more; a connect or a query that does not answer counts
// as lost. Bro's database is small: no migration query comes near the limit.
const pooled = {
  connectionTimeoutMillis: 20_000,
  query_timeout: 120_000,
  max: 1,
};
const lostConnectionMessage =
  /Connection terminated|timeout exceeded when trying to connect|Query read timeout|ECONNRESET|ETIMEDOUT/u;

// drizzle wraps a failed query (DrizzleQueryError) with the driver's error as
// its cause.
function lostConnection(error: Error): boolean {
  return (
    lostConnectionMessage.test(error.message) ||
    (error.cause instanceof Error && lostConnection(error.cause))
  );
}

function openPool(connectionString: string) {
  const pool = new Pool({ connectionString, ...pooled });
  // A connection dropped between queries is an `error` event of the pool:
  // unhandled, it would end the process before the step's retry.
  pool.on("error", (error) => {
    console.log(`migrate: idle connection lost (${error.message})`);
  });
  return pool;
}

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
  const pool = openPool(connection("DATABASE_URL_UNPOOLED", "DATABASE_URL"));
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
  const pool = openPool(connection("WORKFLOW_POSTGRES_URL"));
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

// eve exits at once on SIGTERM (its sandbox shutdown plugin calls
// process.exit) before the queue's graceful shutdown hands its jobs back. A
// job the old process held then stays locked until graphile's 4-hour sweep,
// and the step it ran waits out the workflow core's inline-ownership lease
// (860 s): a turn cut by a restart resumed 14 minutes later. bro-eve.service
// runs this before every start; with one eve per world database every lock
// then belongs to a process that is gone, unless another session is open.
async function unlockWorld() {
  const pool = openPool(connection("WORKFLOW_POSTGRES_URL"));
  try {
    const schema = await pool.query<{ ready: boolean }>(
      "SELECT to_regclass('graphile_worker._private_jobs') IS NOT NULL AS ready"
    );
    if (schema.rows[0]?.ready !== true) {
      console.log("migrate unlock: no queue yet");
      return;
    }
    const others = await pool.query<{ count: string }>(
      "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND pid <> pg_backend_pid()"
    );
    const open = Number(others.rows[0]?.count ?? "0");
    if (open > 0) {
      console.log(
        `migrate unlock: ${String(open)} other sessions on the world database, no lock released`
      );
      return;
    }
    const locked = await pool.query<{ locked_by: string }>(
      "SELECT locked_by FROM graphile_worker._private_jobs WHERE locked_by IS NOT NULL UNION SELECT locked_by FROM graphile_worker._private_job_queues WHERE locked_by IS NOT NULL"
    );
    const workers = locked.rows.map((row) => row.locked_by);
    if (workers.length > 0) {
      const worker = await makeWorkerUtils({ pgPool: pool });
      try {
        await worker.forceUnlockWorkers(workers);
      } finally {
        await worker.release();
      }
    }
    console.log(
      `migrate unlock: released the jobs of ${String(workers.length)} stopped workers`
    );
  } finally {
    await pool.end();
  }
}

async function timed(name: string, step: () => Promise<void>) {
  const started = Date.now();
  try {
    await step();
  } catch (error) {
    if (!(error instanceof Error) || !lostConnection(error)) throw error;
    console.log(`migrate ${name}: lost the connection, once more`);
    await step();
  }
  console.log(`migrate ${name}: done in ${String(Date.now() - started)} ms`);
}

const wanted = process.argv.slice(2);
if (
  wanted.length === 0 ||
  wanted.some((name) => name !== "app" && name !== "world" && name !== "unlock")
) {
  console.error("usage: node ops/migrate.mjs app|world|unlock ...");
  process.exit(2);
}
// Bro's tables first: the world's schema is the one a release can do without.
if (wanted.includes("app")) await timed("app", migrateApp);
if (wanted.includes("world")) await timed("world", migrateWorld);
if (wanted.includes("unlock")) await timed("unlock", unlockWorld);
