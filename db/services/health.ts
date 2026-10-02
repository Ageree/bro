import { sql } from "drizzle-orm";
import { db } from "@db";

/** Whether Postgres answers a trivial query: the app's health check. */
export async function databaseAnswers() {
  await db.execute(sql`select 1`);
}
