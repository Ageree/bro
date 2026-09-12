import { readFileSync } from "node:fs";
import {
  accessEventKind,
  boardTotals,
  browserIsStuck,
  clipOpsDetail,
  compareOpsRows,
  DAY_MS,
  isOpsEventKind,
  jobIsStuck,
  OPS_DETAIL_CAP,
  OPS_EVENT_KINDS,
  OPS_EVENT_TTL_MS,
  STUCK_BROWSER_MS,
  STUCK_JOB_MS,
  tenantFlags,
  tenantHasChat,
  tenantProvisioned,
} from "../convex/lib/opsPolicy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(tenantProvisioned("bro-a1b2c3d4"), "handle is provisioned");
assert(!tenantProvisioned(undefined), "missing handle");
assert(!tenantProvisioned(""), "empty handle");
assert(tenantHasChat("p1", undefined), "photon chat");
assert(tenantHasChat(undefined, "i1"), "inkbox chat");
assert(!tenantHasChat(undefined, undefined), "no chat");

assert(accessEventKind(true, undefined) === "access_ok", "access ok");
assert(accessEventKind(false, "not_ios") === "access_not_ios", "not ios");
assert(accessEventKind(false, "need_phone") === "access_need_phone", "need phone");
assert(accessEventKind(false, "closed") === "access_closed", "closed");
assert(accessEventKind(false, "error") === "access_error", "error");
assert(accessEventKind(false, undefined) === "access_error", "unknown fail");

assert(clipOpsDetail("  hi  ") === "hi", "trim detail");
assert(clipOpsDetail("") === undefined, "empty detail");
assert(clipOpsDetail("x".repeat(200))?.length === OPS_DETAIL_CAP, "cap detail");

const now = 1_000_000;
assert(
  jobIsStuck({ status: "waiting", waitingSince: now - STUCK_JOB_MS, now }),
  "waiting 2h is stuck",
);
assert(
  !jobIsStuck({ status: "waiting", waitingSince: now - 60_000, now }),
  "fresh wait is not stuck",
);
assert(jobIsStuck({ status: "waiting", now }), "waiting without since is stuck");
assert(!jobIsStuck({ status: "open", now }), "open is not stuck");
assert(!jobIsStuck({ status: "done", waitingSince: 0, now }), "done is not stuck");

assert(
  browserIsStuck({ live: true, startedAt: now - STUCK_BROWSER_MS, now }),
  "long browser is stuck",
);
assert(
  !browserIsStuck({ live: true, startedAt: now - 1000, now }),
  "fresh browser is not stuck",
);
assert(browserIsStuck({ live: true, now }), "running without start is stuck");
assert(
  !browserIsStuck({ live: false, startedAt: 0, now }),
  "idle browser is not stuck",
);

assert(
  tenantFlags({
    provisioned: true,
    hasChat: false,
    paywalledToday: true,
    stuckJob: true,
    failedWakeup: false,
    browserStuck: false,
  }).join(",") === "never_wrote,no_chat,paywall,stuck_job",
  "new silent tenant flags",
);
assert(
  tenantFlags({
    provisioned: true,
    lastHumanAt: now,
    hasChat: true,
    paywalledToday: false,
    stuckJob: false,
    failedWakeup: false,
    browserStuck: false,
  }).length === 0,
  "healthy tenant has no flags",
);

const totals = boardTotals({
  now,
  people: [
    { provisioned: true, bound: true, lastHumanAt: now, flags: [] },
    {
      provisioned: true,
      bound: false,
      flags: ["never_wrote", "no_chat"],
    },
    {
      provisioned: true,
      bound: true,
      lastHumanAt: now - DAY_MS - 1,
      flags: ["paywall"],
    },
  ],
  recentKinds: ["access_ok", "access_ok", "access_not_ios", "access_need_phone"],
});
assert(totals.provisioned === 3, "provisioned count");
assert(totals.bound === 2, "bound count");
assert(totals.wrote === 2, "wrote count");
assert(totals.wrote24h === 1, "wrote 24h");
assert(totals.neverWrote === 1, "never wrote");
assert(totals.paywalled === 1, "paywalled");
assert(totals.accessOk24h === 2, "access ok");
assert(totals.accessNotIos24h === 1, "access not ios");

const sorted = [
  { flags: [], lastHumanAt: 2, createdAt: 1 },
  { flags: ["paywall"], lastHumanAt: 1, createdAt: 9 },
  { flags: [], lastHumanAt: 3, createdAt: 1 },
].sort(compareOpsRows);
assert(sorted[0]?.flags[0] === "paywall", "flagged rows first");
assert(sorted[1]?.lastHumanAt === 3, "then recent human");

for (const kind of OPS_EVENT_KINDS) {
  assert(isOpsEventKind(kind), `kind ${kind}`);
}
assert(!isOpsEventKind("message_body"), "no invented kind");
assert(OPS_EVENT_TTL_MS === 14 * 24 * 3600 * 1000, "14 day ttl");

const schema = readFileSync(new URL("../convex/schema.ts", import.meta.url), "utf8");
assert(schema.includes("lastHumanAt"), "schema lastHumanAt");
assert(schema.includes("opsEvents"), "schema opsEvents");
for (const kind of OPS_EVENT_KINDS) {
  assert(schema.includes(`v.literal("${kind}")`), `schema kind ${kind}`);
}
assert(!/messageBody|bodyText|transcript/.test(schema), "schema has no chat bodies");

const tenants = readFileSync(new URL("../convex/tenants.ts", import.meta.url), "utf8");
const countFn = tenants.slice(tenants.indexOf("export const countInboundMessage"));
assert(countFn.includes("lastHumanAt"), "countInbound stamps lastHumanAt");
assert(
  countFn.indexOf('tenant.status === "disabled"') < countFn.indexOf("lastHumanAt"),
  "disabled drop before lastHumanAt",
);
assert(countFn.includes('kind: "first_message"'), "first inbound is an event");
assert(countFn.includes('kind: "paywall"'), "paywall is an event");
assert(tenants.includes('kind: "first_bind"'), "photon bind event");
assert(tenants.includes('kind: "telegram_bound"'), "telegram bind event");

const jobs = readFileSync(new URL("../convex/jobs.ts", import.meta.url), "utf8");
assert(jobs.includes('kind: "job_failed"'), "job fail event");

const wakeups = readFileSync(new URL("../convex/wakeups.ts", import.meta.url), "utf8");
assert(wakeups.includes('kind: "wakeup_failed"'), "wakeup fail event");

const billing = readFileSync(new URL("../convex/billing.ts", import.meta.url), "utf8");
assert(billing.includes('kind: "payment_ok"'), "payment event");

const cabinet = readFileSync(new URL("../convex/cabinet.ts", import.meta.url), "utf8");
assert(cabinet.includes('kind: "cabinet_login"'), "cabinet login event");

const access = readFileSync(new URL("../convex/access.ts", import.meta.url), "utf8");
assert(access.includes("noteAccess"), "access funnel is recorded");
assert(access.includes("accessEventKind"), "access maps codes to kinds");

const http = readFileSync(new URL("../convex/http.ts", import.meta.url), "utf8");
assert(http.includes('path: "/ops"'), "http /ops");
assert(http.includes('path: "/ops/person"'), "http /ops/person");
assert(http.includes("opsAuthed"), "ops uses bearer secret");
assert(
  !/path: "\/ops"[\s\S]{0,400}sessionTenant/.test(http),
  "ops does not use cabinet session",
);

const crons = readFileSync(new URL("../convex/crons.ts", import.meta.url), "utf8");
assert(crons.includes("internal.ops.prune"), "cron prunes ops events");

const eve = readFileSync(new URL("../agent/lib/turn-delivery-events.ts", import.meta.url), "utf8");
assert(eve.includes("noteTurnFailed"), "failed turns reach ops");

const page = readFileSync(new URL("../ops.html", import.meta.url), "utf8");
assert(page.includes("BRO_INTERNAL_SECRET"), "ops page asks for the secret");
assert(page.includes('content="noindex, nofollow"'), "ops is not indexed");
assert(!page.includes("assets/auth.js"), "ops does not use cabinet login");
assert(page.includes("/ops/person"), "ops can open one person");
assert(page.includes("JSON.parse"), "ops parses text, not r.json()");
assert(page.includes("ещё нет /ops"), "ops explains an undeployed route");

const landing = readFileSync(new URL("../index.html", import.meta.url), "utf8");
assert(!landing.includes("ops.html"), "landing does not link ops");

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
assert(
  typeof pkg.scripts?.["vercel-build"] === "string" &&
    pkg.scripts["vercel-build"].includes("ops.html"),
  "vercel-build copies ops.html",
);
assert(pkg.scripts?.["ops:check"]?.includes("ops-check.ts"), "ops:check script");

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
assert(readme.includes("/ops.html"), "readme documents ops");

console.log("ops-check ok");
