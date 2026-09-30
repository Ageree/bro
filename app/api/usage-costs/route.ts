import { createHash, timingSafeEqual } from "node:crypto";
import {
  errandUsageCosts,
  summarizeUsageCosts,
} from "@db/services/usage-costs";
import { env } from "@shared/environment";

export const runtime = "nodejs";

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

/** Compared as digests, so the token's length leaks nothing either. */
function ownerAsked(request: Request) {
  const token = env.USAGE_REPORT_TOKEN;
  const header = request.headers.get("authorization") ?? "";
  const presented = /^Bearer\s+(?<token>\S+)$/u.exec(header)?.groups?.token;
  if (token === undefined || presented === undefined) return false;
  return timingSafeEqual(digest(presented), digest(token));
}

/**
 * The owner's cost report (`docs/agent-costs.md`, 3.1): `?month=2026-09`
 * gives every workspace's spend that month by source, `?run=<id>` one
 * errand's. It answers only the bearer of USAGE_REPORT_TOKEN, and without
 * that token configured it does not exist.
 */
export async function GET(request: Request) {
  if (env.USAGE_REPORT_TOKEN === undefined) {
    return Response.json({ message: "Not found." }, { status: 404 });
  }
  if (!ownerAsked(request)) {
    return Response.json({ message: "Unauthorized." }, { status: 401 });
  }
  const url = new URL(request.url);
  const runId = url.searchParams.get("run");
  if (runId) {
    const errand = await errandUsageCosts(runId);
    return errand === undefined
      ? Response.json({ message: "No costs for this run." }, { status: 404 })
      : Response.json(errand);
  }
  const month = url.searchParams.get("month") ?? currentMonth();
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) {
    return Response.json(
      { message: "month is written as YYYY-MM." },
      { status: 400 }
    );
  }
  return Response.json(await summarizeUsageCosts(month));
}

/** This month in Moscow time, as the report counts months. */
function currentMonth() {
  return new Date(Date.now() + 3 * 60 * 60_000).toISOString().slice(0, 7);
}
