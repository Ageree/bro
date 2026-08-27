import {
  DEFAULT_IDENTITY_CAP,
  identityCap,
  identityCapReached,
  inboundPhoneAction,
  isIosUserAgent,
  isValidHandle,
  makeHandle,
  webhookUrlForHandle,
} from "../convex/lib/accessPolicy.ts";
import { assertSecret, timingSafeEqual } from "../convex/secret.ts";

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

assert(DEFAULT_IDENTITY_CAP === 100, "default cap 100");
assert(identityCap(undefined) === 100, "env unset → 100");
assert(identityCap("250") === 250, "env override");
assert(identityCap("nope") === 100, "env garbage → 100");
assert(identityCap("0") === 100, "env zero → 100");
assert(!identityCapReached(99, DEFAULT_IDENTITY_CAP), "under default cap");
assert(identityCapReached(100, DEFAULT_IDENTITY_CAP), "at default cap");
assert(identityCapReached(101, DEFAULT_IDENTITY_CAP), "over default cap");
assert(!identityCapReached(9, 10), "under explicit 10");
assert(identityCapReached(10, 10), "at explicit 10");

assert(timingSafeEqual("abc", "abc"), "xor equal");
assert(!timingSafeEqual("abc", "abd"), "xor diff char");
assert(!timingSafeEqual("abc", "ab"), "xor diff len");
assert(!timingSafeEqual("", "x"), "xor empty vs x");

const prevSecret = process.env.BRO_INTERNAL_SECRET;
try {
  delete process.env.BRO_INTERNAL_SECRET;
  let threw = false;
  try {
    assertSecret("");
  } catch {
    threw = true;
  }
  assert(threw, "unset env secret rejects");
  process.env.BRO_INTERNAL_SECRET = "";
  threw = false;
  try {
    assertSecret("");
  } catch {
    threw = true;
  }
  assert(threw, "empty env secret rejects");
  process.env.BRO_INTERNAL_SECRET = "s3cret";
  assertSecret("s3cret");
  threw = false;
  try {
    assertSecret("s3creT");
  } catch {
    threw = true;
  }
  assert(threw, "mismatch secret rejects");
} finally {
  if (prevSecret === undefined) delete process.env.BRO_INTERNAL_SECRET;
  else process.env.BRO_INTERNAL_SECRET = prevSecret;
}

assert(
  webhookUrlForHandle("https://app.example/webhooks/imessage", "bro-a1b2c3d4") ===
    "https://app.example/webhooks/imessage?h=bro-a1b2c3d4",
  "query h",
);

console.log("access-policy-check ok");
