import { databaseAnswers } from "@db/services/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Longer than this, the database counts as down: the watchdog asks often. */
const databaseTimeoutMs = 3_000;
/** One probe answers every request for this long: a flood costs one query. */
const reuseMs = 5_000;

let lastProbe: { at: number; ok: boolean } | undefined;
let probeInFlight: Promise<boolean> | undefined;

async function probeDatabase() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("database timeout"));
    }, databaseTimeoutMs);
  });
  try {
    await Promise.race([databaseAnswers(), timeout]);
    return true;
  } catch (error) {
    console.error("[health] the database does not answer", { cause: error });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function databaseHealthy() {
  if (lastProbe && Date.now() - lastProbe.at < reuseMs) {
    return Promise.resolve(lastProbe.ok);
  }
  probeInFlight ??= probeDatabase()
    .then((ok) => {
      lastProbe = { at: Date.now(), ok };
      return ok;
    })
    .finally(() => {
      probeInFlight = undefined;
    });
  return probeInFlight;
}

/**
 * The app's health for the Cloud.ru VM's watchdog and a release's switch
 * (scripts/cloudru-app-host): 200 when Next serves and Postgres answers, 503
 * otherwise. It names no host, error or version. Caddy keeps it from the
 * internet on the VM; concurrent and repeated requests share one probe.
 */
export async function GET() {
  const ok = await databaseHealthy();
  return Response.json(
    { ok },
    { headers: { "cache-control": "no-store" }, status: ok ? 200 : 503 }
  );
}
