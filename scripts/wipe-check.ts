import {
  isWipePhone,
  wipeDecision,
  wipeRefuseMessage,
} from "../convex/lib/wipePolicy.ts";
import { assert, src, srcJson } from "./lib/check.ts";

assert(isWipePhone("+79217818876"), "founder phone shape");
assert(isWipePhone("+79137478678"), "girlfriend phone shape");
assert(!isWipePhone("79217818876"), "missing plus");
assert(!isWipePhone("+0123"), "leading zero");
assert(!isWipePhone("+79"), "too short");
assert(!isWipePhone(""), "empty phone");

const tenant = {
  _id: "t1",
  phoneE164: "+79217818876",
  inkboxHandle: "bro-ers7yotm",
};

assert(
  wipeDecision({
    phoneE164: "+79217818876",
    handle: "bro-ers7yotm",
    tenant,
    handleTenantId: "t1",
  }).ok === true,
  "matching pair",
);

assert(
  wipeDecision({
    phoneE164: "+79217818876",
    handle: "bro-ers7yotm",
    tenant: null,
  }).ok === false,
  "missing tenant",
);

const missing = wipeDecision({
  phoneE164: "+79217818876",
  handle: "bro-ers7yotm",
  tenant: null,
});
assert(!missing.ok && missing.reason === "missing", "missing reason");

const badHandle = wipeDecision({
  phoneE164: "+79217818876",
  handle: "bro-nope",
  tenant,
  handleTenantId: "t1",
});
assert(!badHandle.ok && badHandle.reason === "invalid", "invalid handle");

const swapped = wipeDecision({
  phoneE164: "+79217818876",
  handle: "bro-iofs0ykb",
  tenant,
  handleTenantId: "t2",
});
assert(!swapped.ok && swapped.reason === "mismatch", "handle on another row");

const phoneOnly = wipeDecision({
  phoneE164: "+79217818876",
  handle: "bro-ers7yotm",
  tenant: { _id: "t1", phoneE164: "+79217818876" },
  handleTenantId: null,
});
assert(!phoneOnly.ok && phoneOnly.reason === "mismatch", "tenant missing handle");

const leftover = wipeDecision({
  phoneE164: "+79001112233",
  handle: "bro-ers7yotm",
  tenant: {
    _id: "fake",
    phoneE164: "+79001112233",
    inkboxHandle: "bro-5pnhi6ar",
  },
  handleTenantId: "other",
});
assert(!leftover.ok && leftover.reason === "mismatch", "leftover fake stays");

assert(
  wipeRefuseMessage("mismatch").includes("same tenant"),
  "mismatch message",
);

assert(
  src("convex/lib/accessPolicy.ts").includes("/^bro-[a-z0-9]{8}$/"),
  "handle rule matches accessPolicy",
);
assert(
  src("convex/lib/wipePolicy.ts").includes("/^bro-[a-z0-9]{8}$/"),
  "wipe handle rule is the same regex",
);

const wipeSrc = src("convex/wipe.ts");
assert(wipeSrc.includes("internalMutation"), "wipe is internal");
assert(wipeSrc.includes("internalQuery"), "preview is internal");
assert(!/export const \w+ = mutation\(/.test(wipeSrc), "no public mutation");
assert(!/export const \w+ = query\(/.test(wipeSrc), "no public query");
assert(!/export const \w+ = action\(/.test(wipeSrc), "no public action");
assert(wipeSrc.includes('confirm: v.literal("wipe")'), "confirm wipe required");
assert(wipeSrc.includes("wipeByPhoneAndHandle"), "wipe export");
assert(wipeSrc.includes("previewByPhoneAndHandle"), "preview export");
assert(
  !wipeSrc.includes("79001112233") && !wipeSrc.includes("79217818876"),
  "wipe module has no hardcoded phones",
);

const helperSrc = src("convex/lib/tenantWipe.ts");
assert(helperSrc.includes("ctx.storage.delete"), "files drop storage blobs");
assert(helperSrc.includes("unscheduleCron"), "wakeup crons unschedules");
assert(helperSrc.includes("ctx.db.delete(tenant._id)"), "tenant row deleted");
assert(!src("convex/http.ts").includes("wipeByPhoneAndHandle"), "http has no wipe route");

const pkg = srcJson<{ scripts: Record<string, string> }>("package.json");
assert(typeof pkg.scripts["wipe:check"] === "string", "wipe:check script");

console.log("wipe-check ok");
