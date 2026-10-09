import { Client } from "pg";
import { env } from "@shared/environment";

/**
 * Whether Postgres answers a trivial query within `timeoutMs`: the app's
 * health check. Its own connection, not the app's pool: a stalled probe
 * holds no pooled connection and queues no app query, and the timeouts end
 * it on the client. No `statement_timeout` startup parameter: a connection
 * pooler in front of the server (Selectel's managed PostgreSQL) refuses the
 * whole connection over it ("unsupported startup parameter"), and the probe
 * is a `select 1`.
 */
export async function databaseAnswers(timeoutMs: number) {
  const client = new Client({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  // A late socket error on a probe that is already over must not crash the
  // app: without a listener `error` is thrown as an uncaught exception.
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("select 1");
  } finally {
    // Not awaited: a dead peer would hold the answer past the deadline.
    client.end().catch(() => undefined);
  }
}
