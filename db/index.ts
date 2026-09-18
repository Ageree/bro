import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import {
  drizzle,
  type NodePgClient,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@shared/environment";
import * as schema from "./schema";

export * from "./schema";

/**
 * Deployments talk to Postgres over a pooled TCP connection. A maintenance run
 * from a machine with HTTPS egress only — the one-off Convex import is the
 * current case — selects Neon's HTTP driver with `DATABASE_DRIVER=neon-http`.
 * It answers the same query builder, but every statement is its own request:
 * there are no interactive transactions, so a `db.transaction` block degrades
 * to plain sequential statements and each step has to be idempotent on its own.
 */
function createDatabaseClient(): NodePgDatabase<typeof schema> & {
  $client: NodePgClient;
} {
  if (env.DATABASE_DRIVER === "neon-http") {
    const httpClient = drizzleNeonHttp({
      client: neon(env.DATABASE_URL),
      schema,
    });
    // SAFETY: The HTTP driver implements the query-builder surface this
    // application uses; only the transport and transaction support differ.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This swaps only the driver while keeping one shared Drizzle schema and query-builder contract.
    return httpClient as never;
  }

  return drizzle({
    client: new Pool({ connectionString: env.DATABASE_URL }),
    schema,
  });
}

export const db = createDatabaseClient();
