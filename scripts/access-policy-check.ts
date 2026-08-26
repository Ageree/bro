import {
  identityCapReached,
  inboundPhoneAction,
  isIosUserAgent,
  isValidHandle,
  makeHandle,
  webhookUrlForHandle,
} from "../convex/lib/accessPolicy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(isValidHandle("bro-a1b2c3d4"), "valid handle");
assert(!isValidHandle("bro-ageree"), "old handle is not v1 format");
assert(!isValidHandle("Bro-a1b2c3d4"), "case");
assert(!isValidHandle("bro-short"), "length");

let i = 0;
const seq = () => {
  const n = i++;
  return (n % 36) / 36;
};
const h = makeHandle(seq);
assert(isValidHandle(h), `generated ${h}`);
assert(h.startsWith("bro-"), "prefix");

assert(isIosUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "iphone");
assert(isIosUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"), "ipad");
assert(!isIosUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "mac");
assert(!isIosUserAgent("Mozilla/5.0 (Linux; Android 14)"), "android");

assert(inboundPhoneAction(undefined, "+79001112233") === "bind", "first phone");
assert(inboundPhoneAction("+79001112233", "+79001112233") === "ok", "same phone");
assert(inboundPhoneAction("+79001112233", "+79009999999") === "reject", "other phone");

assert(!identityCapReached(9, 10), "under cap");
assert(identityCapReached(10, 10), "at cap");
assert(identityCapReached(11, 10), "over cap");

assert(
  webhookUrlForHandle("https://app.example/webhooks/imessage", "bro-a1b2c3d4") ===
    "https://app.example/webhooks/imessage?h=bro-a1b2c3d4",
  "query h",
);

console.log("access-policy-check ok");
