import {
  CABINET_TIMEZONES,
  DEFAULT_TZ,
  isValidIanaTimeZone,
  normalizeTz,
  resolveTenantTz,
  sessionTzChangeDecision,
  type SessionTzChangeResult,
} from "../convex/lib/tzPolicy.ts";

import { assert, src } from "./lib/check.ts";

function failCode(r: SessionTzChangeResult): "unbound" | "invalid" {
  if (r.ok) throw new Error("expected tz change to fail");
  return r.code;
}

assert(DEFAULT_TZ === "Europe/Moscow", "default Europe/Moscow");
assert(normalizeTz("  Europe/Moscow  ") === "Europe/Moscow", "normalize trims");
assert(normalizeTz("") === "", "normalize empty stays empty");
assert(normalizeTz("\nAsia/Almaty\t") === "Asia/Almaty", "normalize inner edges");

assert(isValidIanaTimeZone("Europe/Moscow"), "msk valid");
assert(isValidIanaTimeZone("  Asia/Vladivostok  "), "trim then valid");
assert(isValidIanaTimeZone("America/New_York"), "any IANA valid");
assert(isValidIanaTimeZone("UTC"), "UTC valid");
assert(!isValidIanaTimeZone(""), "empty invalid");
assert(!isValidIanaTimeZone("   "), "whitespace invalid");
assert(!isValidIanaTimeZone("not-a-zone"), "garbage invalid");
assert(!isValidIanaTimeZone("UTC+3"), "offset garbage");
assert(!isValidIanaTimeZone("MSK"), "abbrev garbage");
assert(!isValidIanaTimeZone("Europe/NotACity"), "fake city");
assert(!isValidIanaTimeZone("Invalid/Timezone"), "invalid iana");

assert(CABINET_TIMEZONES.includes(DEFAULT_TZ), "default in cabinet list");
assert(CABINET_TIMEZONES[0] === "Europe/Kaliningrad", "list starts west");
for (const tz of CABINET_TIMEZONES) {
  assert(isValidIanaTimeZone(tz), `cabinet zone ${tz}`);
}
assert(CABINET_TIMEZONES.includes("Europe/Kyiv"), "CIS Kyiv");
assert(CABINET_TIMEZONES.includes("Asia/Almaty"), "CIS Almaty");
assert(CABINET_TIMEZONES.includes("Asia/Kamchatka"), "RU Kamchatka");

assert(resolveTenantTz(undefined) === DEFAULT_TZ, "missing tz → default");
assert(resolveTenantTz(null) === DEFAULT_TZ, "null tz → default");
assert(resolveTenantTz("  Asia/Almaty  ") === "Asia/Almaty", "stored trim");
assert(resolveTenantTz("nope") === DEFAULT_TZ, "garbage stored → default");

assert(
  failCode(sessionTzChangeDecision({ tz: "Europe/Moscow" })) === "unbound",
  "no phone → unbound",
);
assert(
  failCode(sessionTzChangeDecision({ phoneE164: "", tz: "Europe/Moscow" })) ===
    "unbound",
  "empty phone → unbound",
);
assert(
  failCode(sessionTzChangeDecision({ phoneE164: "   ", tz: "Europe/Moscow" })) ===
    "unbound",
  "whitespace phone → unbound",
);
assert(
  failCode(sessionTzChangeDecision({ tz: "not-a-zone" })) === "unbound",
  "unbound wins over invalid tz",
);
assert(
  failCode(
    sessionTzChangeDecision({ phoneE164: "+79001112233", tz: "not-a-zone" }),
  ) === "invalid",
  "bound + garbage",
);
assert(
  failCode(sessionTzChangeDecision({ phoneE164: "+79001112233", tz: "" })) ===
    "invalid",
  "bound + empty tz",
);

const ok = sessionTzChangeDecision({
  phoneE164: "+79001112233",
  tz: "  Asia/Yekaterinburg  ",
});
if (!ok.ok) throw new Error("bound + trimmed IANA");
assert(ok.tz === "Asia/Yekaterinburg", "bound + trimmed IANA");

const httpSrc = src("convex/http.ts");
assert(httpSrc.includes('path: "/me/tz"'), "http /me/tz route");
assert(
  httpSrc.includes('path: "/me/tz", method: "OPTIONS"') ||
    httpSrc.includes('path: "/me/tz",\n  method: "OPTIONS"') ||
    /path: "\/me\/tz"[\s\S]{0,80}method: "OPTIONS"/.test(httpSrc),
  "http /me/tz OPTIONS",
);
assert(httpSrc.includes('method: "POST"'), "http has POST");
assert(httpSrc.includes("setTzForSession"), "http uses session tz mutation");
assert(httpSrc.includes("getSessionTenant"), "http session lookup");
assert(
  !httpSrc.includes("api.tenants.setTimezone"),
  "http does not call public setTimezone",
);
assert(
  !/path: "\/me\/tz"[\s\S]{0,800}assertSecret/.test(httpSrc),
  "http /me/tz does not use agent secret",
);
assert(
  !/path: "\/me\/tz"[\s\S]{0,800}BRO_INTERNAL_SECRET/.test(httpSrc),
  "http /me/tz does not send BRO_INTERNAL_SECRET",
);

const cabinetSrc = src("convex/cabinet.ts");
assert(cabinetSrc.includes("export const setTzForSession"), "cabinet setTzForSession");
assert(
  cabinetSrc.includes("applyTimezoneForTenantId"),
  "session reuses tenant-id path",
);

const tenantsSrc = src("convex/tenants.ts");
assert(tenantsSrc.includes("export const setTimezoneForTenantId"), "internal by id");
assert(tenantsSrc.includes("applyTimezoneChange"), "shared carry helper");
assert(tenantsSrc.includes("carryCountersOnTzChange"), "still carries counters");
assert(tenantsSrc.includes("assertSecret"), "public setTimezone still secret");
assert(
  tenantsSrc.includes('throw new Error("invalid timezone")'),
  "public setTimezone still throws invalid",
);

const wakeupSrc = src("agent/tools/schedule_wakeup.ts");
assert(wakeupSrc.includes("getTenant"), "wakeup reads tenant");
assert(wakeupSrc.includes("upsertTenant"), "wakeup can upsert");
assert(wakeupSrc.includes("resolveTenantTz"), "wakeup uses tenant tz helper");
assert(
  !/const TZ = "Europe\/Moscow"/.test(wakeupSrc),
  "wakeup no longer hardcodes TZ",
);

console.log("tz-check ok");
