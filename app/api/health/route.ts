import { databaseAnswers } from "@db/services/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Longer than this, the database counts as down: the watchdog asks often. */
const databaseTimeoutMs = 3_000;

/**
 * The app's health for the Cloud.ru VM's watchdog and a release's switch
 * (scripts/cloudru-app-host): 200 when Next serves and Postgres answers, 503
 * otherwise. It names no host, error or version: anyone may ask it.
 */
export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("database timeout"));
    }, databaseTimeoutMs);
  });
  try {
    await Promise.race([databaseAnswers(), timeout]);
    return Response.json(
      { ok: true },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    console.error("[health] the database does not answer", { cause: error });
    return Response.json(
      { ok: false },
      { headers: { "cache-control": "no-store" }, status: 503 }
    );
  } finally {
    clearTimeout(timer);
  }
}
