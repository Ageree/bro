/**
 * B3 — glue checks. Behavioural coverage for currently-untested production
 * entry points identified by audits/A7-checks-channels.md Part A: the v4
 * live-URL resolver actually used at the call sites, the CDP HTTP helpers,
 * the wakeup-claim string parser, errand-start URL resolution, the
 * live-session boundary, the guard rails on parsed amounts, the pay/login
 * secret bindings, the dry-run inject text, and WB-style order parsing.
 */
import { assert, eq, src, throws } from "./lib/check.ts";

import {
  liveUrlFromRunPayloads,
  pickLiveUrl,
  runEventsPath,
} from "../convex/lib/browserLivePolicy.ts";
import { chatConversationId } from "../convex/lib/tenantConversation.ts";
import {
  asCdpTargets,
  browserFromList,
  cdpHttpBase,
  pickCdpPage,
  type CdpTarget,
} from "../convex/lib/browserCdp.ts";
import {
  claimMatchesRunPhase,
  parseWakeupClaim,
} from "../convex/lib/browserFollowPolicy.ts";
import { errandStartUrl } from "../convex/lib/browserStartPolicy.ts";
import { cloudSessionLooksLive, injectQueueText } from "../convex/lib/browserInjectPolicy.ts";
import { parseAmount } from "../agent/lib/purchase-policy.ts";
import { cardBindings, loginBindings, normalizePayHosts } from "../agent/lib/browser-pay.ts";
import { parseOrderFromResult } from "../agent/lib/order-policy.ts";
import type { LoginPayload, PaymentPayload } from "../convex/lib/vaultPayload.ts";

// ============================================================================
// 1. liveUrlFromRunPayloads / pickLiveUrl — precedence + nest-key allowlist
// ============================================================================

// precedence: run > session > events (matches the `??` chain order)
{
  const run = { data: { live_view_url: "https://live.browser-use.com/from-run" } };
  const session = { live_view_url: "https://live.browser-use.com/from-session" };
  const events = {
    events: [
      {
        type: "browser.ready",
        data: { live_view_url: "https://live.browser-use.com/from-events" },
      },
    ],
  };
  eq(
    liveUrlFromRunPayloads({ run, session, events }),
    "https://live.browser-use.com/from-run",
    "run wins over session and events",
  );
  eq(
    liveUrlFromRunPayloads({ session, events }),
    "https://live.browser-use.com/from-session",
    "session wins over events when run is absent",
  );
  eq(
    liveUrlFromRunPayloads({ events }),
    "https://live.browser-use.com/from-events",
    "events used only when run and session are both absent",
  );
  eq(liveUrlFromRunPayloads({}), undefined, "nothing present → undefined");
}

// realistic multi-event v4 payload: only the LAST browser.ready event carries
// the url, nested one level deeper than the flat shape (data.browser.live_view_url)
{
  const events = {
    events: [
      { type: "run.created", data: {} },
      { type: "browser.ready", data: {} },
      { type: "tool.navigate", data: { url: "https://example.com/" } },
      {
        type: "browser.ready",
        data: { browser: { live_view_url: "https://live.browser-use.com/deep-nest" } },
      },
    ],
  };
  eq(
    liveUrlFromRunPayloads({ events }),
    "https://live.browser-use.com/deep-nest",
    "finds a url nested one level deeper (data.browser.live_view_url) on the last ready event",
  );
}

// pickLiveUrl with bare run/session shapes (never wrapped in {events:[...]})
eq(
  pickLiveUrl({ liveUrl: "https://live.browser-use.com/bare-run" }),
  "https://live.browser-use.com/bare-run",
  "pickLiveUrl matches a top-level key directly on a bare run object",
);
eq(
  pickLiveUrl({ session: { live_view_url: "https://live.browser-use.com/bare-session" } }),
  "https://live.browser-use.com/bare-session",
  "pickLiveUrl descends into a bare session object's `session` nest key",
);

// boundary of the nest-key allowlist: only data/browser/session/payload are
// descended into — any other wrapper key is not traversed.
eq(
  pickLiveUrl({ payload: { live_view_url: "https://live.browser-use.com/via-payload" } }),
  "https://live.browser-use.com/via-payload",
  "`payload` is inside the nest-key allowlist",
);
eq(
  pickLiveUrl({ result: { live_view_url: "https://live.browser-use.com/via-result" } }),
  undefined,
  "`result` is NOT in the nest-key allowlist — a url nested only there is not found",
);
eq(
  pickLiveUrl({ meta: { data: { live_view_url: "https://live.browser-use.com/double-wrap" } } }),
  undefined,
  "an allowlisted key one level under a non-allowlisted wrapper is still unreachable",
);

// ============================================================================
// 2. runEventsPath, cdpHttpBase, pickCdpPage, browserFromList
// ============================================================================

eq(
  runEventsPath("run_abc123"),
  "/runs/run_abc123/events?limit=200&after=0",
  "runEventsPath builds the v4 events path",
);

eq(cdpHttpBase("ws://10.0.0.1:9222/devtools"), "http://10.0.0.1:9222/devtools", "ws → http");
eq(cdpHttpBase("wss://cdp.example.com/devtools"), "https://cdp.example.com/devtools", "wss → https");
eq(cdpHttpBase("ws://10.0.0.1:9222/devtools/"), "http://10.0.0.1:9222/devtools", "trailing slash trimmed");
eq(cdpHttpBase("wss://cdp.example.com/"), "https://cdp.example.com", "trailing slash trimmed after wss");

{
  const targets: CdpTarget[] = [
    { id: "1", type: "background_page", url: "https://x.invalid/bg" },
    { id: "2", type: "iframe", url: "https://x.invalid/frame" },
    { id: "3", type: "page", url: "https://taxi.yandex.ru/order" },
  ];
  eq(pickCdpPage(targets)?.id, "3", "pickCdpPage prefers type:page over earlier entries");
  eq(
    pickCdpPage([targets[0]!, targets[1]!])?.id,
    "1",
    "falls back to the first target when no page type is present",
  );
  assert(asCdpTargets(targets).length === 3, "asCdpTargets passes through valid targets");
}

{
  const raw = {
    items: [
      {
        agent_session_id: "sess-snake",
        id: "browser-1",
        live_url: "https://live.browser-use.com/snake",
        cdp_url: "ws://cdp.example.com/snake",
      },
      {
        agentSessionId: "sess-camel",
        id: "browser-2",
        liveUrl: "https://live.browser-use.com/camel",
        cdpUrl: "ws://cdp.example.com/camel",
      },
    ],
  };
  assert(
    JSON.stringify(browserFromList(raw, "sess-snake")) ===
      JSON.stringify({
        id: "browser-1",
        liveUrl: "https://live.browser-use.com/snake",
        cdpUrl: "ws://cdp.example.com/snake",
      }),
    "browserFromList reads snake_case fields",
  );
  assert(
    JSON.stringify(browserFromList(raw, "sess-camel")) ===
      JSON.stringify({
        id: "browser-2",
        liveUrl: "https://live.browser-use.com/camel",
        cdpUrl: "ws://cdp.example.com/camel",
      }),
    "browserFromList reads camelCase fields",
  );
  eq(browserFromList(raw, "sess-missing"), undefined, "no matching session → undefined");
}

// ============================================================================
// 3. parseWakeupClaim / claimMatchesRunPhase — malformed / legacy / colons
// ============================================================================

eq(parseWakeupClaim(undefined), null, "undefined claim → null");
eq(parseWakeupClaim(""), null, "empty claim → null");
eq(parseWakeupClaim("tooshort:pending"), null, "fewer than 4 parts → null");
eq(
  parseWakeupClaim("run1:done:1000:not-a-status"),
  null,
  "unknown trailing status → null (must be pending or sent)",
);
eq(
  parseWakeupClaim("run1:done:not-a-number:pending"),
  null,
  "non-numeric claimedAtMs → null",
);

// well-formed claim
assert(
  JSON.stringify(parseWakeupClaim("run1:done:1000:pending")) ===
    JSON.stringify({ runId: "run1", phase: "done", claimedAtMs: 1000, status: "pending" }),
  "well-formed claim parses",
);

// runId itself contains colons — must not be mistaken for extra fields
assert(
  JSON.stringify(parseWakeupClaim("tenant:abc:run:123:done:2000:sent")) ===
    JSON.stringify({ runId: "tenant:abc:run:123", phase: "done", claimedAtMs: 2000, status: "sent" }),
  "colons inside the runId are preserved (only the last 3 `:`-fields are structured)",
);

// legacy `${runId}:${phase}` claims (pre-dating the structured format) — the
// parser rejects them (too few parts) but claimMatchesRunPhase still honors
// the literal legacy shape as a fallback.
eq(parseWakeupClaim("run1:done"), null, "legacy 2-part claim does not parse structurally");
assert(
  claimMatchesRunPhase("run1:done", "run1", "done"),
  "claimMatchesRunPhase falls back to literal `${runId}:${phase}` match for legacy claims",
);
assert(
  !claimMatchesRunPhase("run1:done", "run2", "done"),
  "legacy fallback does not match a different runId",
);
assert(
  claimMatchesRunPhase("run1:done:1000:pending", "run1", "done"),
  "structured claim matches by parsed runId/phase",
);
assert(
  claimMatchesRunPhase("tenant:abc:run:123:done:2000:sent", "tenant:abc:run:123", "done"),
  "structured claim with colons in runId still matches via the parsed fields",
);
assert(
  !claimMatchesRunPhase("tenant:abc:run:123:done:2000:sent", "tenant:abc:run:123", "giveup"),
  "structured claim does not match the wrong phase",
);
assert(
  !claimMatchesRunPhase("garbage", "run1", "done"),
  "unparseable, non-legacy-shaped claim never matches",
);

// ============================================================================
// 4. errandStartUrl — bare Cyrillic wording, explicit URL w/ trailing comma,
//    unrelated text
// ============================================================================

eq(errandStartUrl("озон"), "https://www.ozon.ru/", "bare «озон» → Ozon");
eq(errandStartUrl("вайлдберриз"), "https://www.wildberries.ru/", "bare «вайлдберриз» → WB");
eq(errandStartUrl("такси до аэропорта"), "https://taxi.yandex.ru/", "«такси до аэропорта» → taxi");
eq(
  errandStartUrl("Открой https://www.ozon.ru/product/123, купи товар"),
  "https://www.ozon.ru/product/123",
  "explicit URL followed by a trailing comma has the comma stripped",
);
eq(errandStartUrl("напиши маме, что задержусь"), undefined, "unrelated text → undefined");
eq(errandStartUrl(undefined), undefined, "no task text → undefined");

// Fixed (A3 addendum item 16): the WB branch now uses the same
// `(?:^|[^\p{L}])(?:wb|вб)(?:[^\p{L}]|$)` / `u`-flag pattern as
// `agent/lib/order-policy.ts`'s `merchantFromTask`, so a bare Cyrillic «вб»
// resolves like every other bare-wording case above.
eq(errandStartUrl("вб"), "https://www.wildberries.ru/", "bare «вб» resolves to WB");
eq(
  errandStartUrl("закажи на вб"),
  "https://www.wildberries.ru/",
  "«вб» inside a sentence resolves to WB",
);

// ============================================================================
// 5. cloudSessionLooksLive — SESSION_LIVE_MS (20 min) boundary
// ============================================================================

{
  const now = Date.parse("2026-09-14T12:00:00.000Z");
  const SESSION_LIVE_MS = 20 * 60_000;

  // exactly at the boundary (elapsed === SESSION_LIVE_MS) → not live: the
  // source checks `now - startedAt < SESSION_LIVE_MS`, a strict `<`.
  assert(
    !cloudSessionLooksLive({
      status: "completed",
      sessionId: "s",
      runId: "r",
      startedAt: now - SESSION_LIVE_MS,
      now,
    }),
    "exactly at the 20-min boundary is NOT live (strict <, browserProbed unset)",
  );
  // one ms inside the window → live
  assert(
    cloudSessionLooksLive({
      status: "completed",
      sessionId: "s",
      runId: "r",
      startedAt: now - (SESSION_LIVE_MS - 1),
      now,
    }),
    "one ms inside the 20-min window is live (browserProbed unset)",
  );
  // browserProbed: true short-circuits to false regardless of where the
  // elapsed time sits relative to the boundary.
  assert(
    !cloudSessionLooksLive({
      status: "completed",
      sessionId: "s",
      runId: "r",
      browserListed: false,
      browserProbed: true,
      startedAt: now - (SESSION_LIVE_MS - 1),
      now,
    }),
    "browserProbed:true overrides the elapsed-time fallback even inside the window",
  );
}

// ============================================================================
// 6. parseAmount guard rails
// ============================================================================

eq(parseAmount("0", false), undefined, "zero is rejected");
eq(parseAmount("-500", false), undefined, "negative is rejected");
eq(parseAmount("-1", true), undefined, "negative thousands is rejected");
eq(parseAmount("10000001", false), undefined, "just above the 10,000,000 cap is rejected");
eq(parseAmount("10000000", false), 10_000_000, "exactly at the cap is accepted");
eq(parseAmount("1 500,50", false), 1501, "space thousands + comma decimal, rounded");
eq(parseAmount("1 500,50", false), 1501, "non-breaking-space thousands + comma decimal");
eq(parseAmount("abc", false), undefined, "non-numeric text is rejected");

// ============================================================================
// 7. cardBindings / loginBindings throw on empty hosts;
//    normalizePayHosts rejects an IP and localhost
// ============================================================================

{
  const card: PaymentPayload = {
    kind: "payment-card",
    version: 1,
    cardholderName: "IVAN PETROV",
    number: "4111111111111111",
    expirationMonth: 3,
    expirationYear: 2027,
    securityCode: "123",
    billingPostalCode: undefined,
  };
  throws(() => cardBindings(card, []), "cardBindings throws on empty hosts", "at least one allowed host");

  const login: LoginPayload = {
    kind: "login",
    version: 1,
    origin: "https://taxi.yandex.ru",
    identifier: { type: "email", value: "sava@mail.ru" },
    authentication: { type: "password", password: ["bro", "test", "fixture"].join("-") },
  };
  throws(() => loginBindings(login, []), "loginBindings throws on empty hosts", "at least one allowed host");
}

assert(
  JSON.stringify(normalizePayHosts(["ozon.ru", "127.0.0.1", "wildberries.ru"])) ===
    JSON.stringify(["ozon.ru", "wildberries.ru"]),
  "normalizePayHosts drops a bare IP",
);
assert(
  JSON.stringify(normalizePayHosts(["localhost", "taxi.yandex.ru"])) ===
    JSON.stringify(["taxi.yandex.ru"]),
  "normalizePayHosts drops localhost",
);
assert(
  JSON.stringify(normalizePayHosts(["10.0.0.5", "localhost", "::1"])) === JSON.stringify([]),
  "IP + localhost + IPv6 loopback all dropped",
);

// ============================================================================
// 8. injectQueueText({kind:"code", alreadyTyped:true, dryRun:true}) —
//    combined flags: no digits, no order-confirm instruction
// ============================================================================

{
  const text = injectQueueText({
    kind: "code",
    humanText: "482911",
    code: "482911",
    alreadyTyped: true,
    dryRun: true,
  });
  assert(!/\d/.test(text), "combined alreadyTyped+dryRun code text has no digits");
  assert(
    !/оформи|подтверди заказ|нажми.*заказать|оплати/i.test(text),
    "combined text carries no order-confirm instruction",
  );
  assert(text.includes("остановись"), "dryRun's stop-and-don't-order line is still appended");
  assert(text.includes("Код уже введён"), "alreadyTyped's already-typed line is still used");
}

// ============================================================================
// 9. parseOrderFromResult — WB-style "was X, now Y" price, order id after
// ============================================================================

{
  const order = parseOrderFromResult({
    task: "купи кроссовки на wb",
    result: "«Кроссовки Nike» Было 6990 ₽, сейчас 4990 ₽. Заказ №123456",
  });
  assert(order, "order parses");
  eq(order!.priceRub, 4990, "the later (discounted) marked price wins, not the crossed-out one");
  eq(order!.merchantOrderId, "123456", "order id extracted from «Заказ №...»");
  eq(order!.merchant, "wb", "merchant resolved from task wording");
  eq(order!.status, "placed", "an order id present → placed");
}

// ============================================================================
// 10. chatConversationId — Photon-onboarded tenants (photonConversationId,
//    no inkboxConversationId — Inkbox is mail-only now) must still resolve a
//    chat conversation everywhere a background wakeup looks one up.
// ============================================================================

eq(
  chatConversationId({ photonConversationId: "any;-;+7921", inkboxConversationId: "ib1" }),
  "any;-;+7921",
  "photon wins when both are set",
);
eq(
  chatConversationId({ inkboxConversationId: "ib1" }),
  "ib1",
  "falls back to inkbox when photon is absent",
);
eq(
  chatConversationId({ photonConversationId: "any;-;+7921" }),
  "any;-;+7921",
  "photon-only tenant resolves (the production bug: no inkboxConversationId at all)",
);
eq(chatConversationId({}), undefined, "neither field set → undefined");
eq(chatConversationId(null), undefined, "null tenant → undefined");
eq(chatConversationId(undefined), undefined, "undefined tenant → undefined");
eq(
  chatConversationId({ photonConversationId: "  ", inkboxConversationId: "ib1" }),
  "ib1",
  "blank photon id is treated as absent, falls back to inkbox",
);
eq(
  chatConversationId({ inkboxConversationId: "   " }),
  undefined,
  "blank inkbox id with no photon id → undefined, not whitespace",
);

// Source-level: the tenant-facing wakeup paths must read the conversation id
// through chatConversationId(), never a bare tenant.inkboxConversationId —
// or a Photon-only tenant (no inkboxConversationId) silently never wakes up.
const tenantsSrc = src("convex/tenants.ts");
{
  const claimBrowserWakeupFn = tenantsSrc.slice(
    tenantsSrc.indexOf("export const claimBrowserWakeup"),
    tenantsSrc.indexOf("export const releaseBrowserWakeup"),
  );
  assert(
    claimBrowserWakeupFn.includes("chatConversationId(existing)"),
    "claimBrowserWakeup resolves the conversation via chatConversationId(), not a bare inkboxConversationId read",
  );
  assert(
    !/conversationId:\s*existing\.inkboxConversationId/.test(claimBrowserWakeupFn),
    "claimBrowserWakeup no longer returns the bare inkboxConversationId field",
  );
}

const wakeupsSrcForConv = src("convex/wakeups.ts");
assert(
  wakeupsSrcForConv.includes("chatConversationId(tenant)"),
  "wakeups.ts deliverOne resolves the conversation via chatConversationId()",
);
assert(
  !/tenant\??\.inkboxConversationId/.test(wakeupsSrcForConv),
  "wakeups.ts no longer reads tenant.inkboxConversationId directly",
);

const watchersSrcForConv = src("convex/watchers.ts");
assert(
  watchersSrcForConv.includes("chatConversationId(tenant)"),
  "watchers.ts deliverEvent resolves the conversation via chatConversationId()",
);
assert(
  !/tenant\??\.inkboxConversationId/.test(watchersSrcForConv),
  "watchers.ts no longer reads tenant.inkboxConversationId directly",
);

// wakeupAgent: a claim that succeeds but finds no chat conversation must log
// loudly and release the claim (not leave browserWakeupClaim stuck pending
// forever) instead of silently swallowing the failure.
const browserFollowSrc = src("convex/browserFollow.ts");
{
  const wakeupAgentFn = browserFollowSrc.slice(
    browserFollowSrc.indexOf("export const wakeupAgent"),
    browserFollowSrc.indexOf("const stuckOnNeedRow"),
  );
  const noConvBlock = wakeupAgentFn.slice(
    wakeupAgentFn.indexOf("if (!claimed.conversationId)"),
    wakeupAgentFn.indexOf("no conversation") + "no conversation".length + 5,
  );
  assert(
    noConvBlock.includes("console.error("),
    "wakeupAgent logs when a claimed wakeup has no chat conversation",
  );
  assert(
    noConvBlock.includes("internal.tenants.releaseBrowserWakeup"),
    "wakeupAgent releases the browserWakeupClaim when there is no conversation to notify",
  );
}

console.log("browser-glue-check ok");
