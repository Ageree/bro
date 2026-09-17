// Cloud testing: the test-tenant range, the recorder sink, and the synthetic
// Photon inbound a scenario drives Bro with.
//
// The properties that matter most here are the safety ones. The suite is
// allowed to run against a deployment that also serves real people, so the
// test range has to be unreachable by accident from either side: a real phone
// must never read as a test phone, and a test tenant's outbound must never
// reach a transport.
import {
  isTestPhone,
  photonTestInbound,
  TEST_PHONE_PREFIX,
  testPhoneFor,
  testPhoneFromSpaceId,
  testSpaceId,
} from "../convex/lib/testTenantPolicy.ts";
import {
  photonWebhookOk,
  readPhotonInbound,
  signSpectrumWebhook,
} from "../agent/lib/photon.ts";
import { isBluePhotonService } from "../convex/lib/photonPolicy.ts";
import { deliverHuman } from "../agent/lib/deliver-human.ts";
import { compileTestBubbles, type TestDelivery } from "../agent/lib/test-sink.ts";
import { resetBubbleDedupe } from "../agent/lib/bubble-dedupe.ts";
import { SCENARIOS } from "./lib/scenarios.ts";

import { assert, eq, src } from "./lib/check.ts";

/** The body of a named async function in the iMessage channel, up to the next
 *  top-level declaration. Enough to see which send path it uses. */
function channelSrcForOnboarding(): (fn: string) => string {
  const text = src("agent/channels/imessage.ts");
  return (fn: string) => {
    const start = text.indexOf(`async function ${fn}(`);
    assert(start >= 0, `${fn} still exists`);
    const next = text.indexOf("\nasync function ", start + 1);
    return text.slice(start, next > 0 ? next : start + 4000);
  };
}

// ---------------------------------------------------------------- the range

for (const real of [
  "+79161234567",
  "+14155550123", // a real area code that merely contains 555
  "+15551234567", // area code 555, ordinary exchange — still not ours
  "+442071234567",
  "",
  "   ",
  TEST_PHONE_PREFIX, // the bare prefix is not a tenant
]) {
  assert(!isTestPhone(real), `real phone is not a test phone: ${real}`);
}
assert(!isTestPhone(undefined), "undefined is not a test phone");
assert(!isTestPhone(null), "null is not a test phone");
for (const test of ["+15555550000", "+15555552880", "+15555559999"]) {
  assert(isTestPhone(test), `test phone: ${test}`);
}

// The prefix is deliberately not configurable — see the module comment. If it
// ever becomes an env var, this check is the thing that should have to change
// with it.
const policySrc = src("convex/lib/testTenantPolicy.ts");
assert(
  !/process\.env/.test(policySrc),
  "the test range is a constant, not an env var",
);

// ------------------------------------------------------------ one per scenario

eq(testPhoneFor("onboard"), testPhoneFor("onboard"), "scenario phone is stable");
assert(
  testPhoneFor("onboard") !== testPhoneFor("buy"),
  "different scenarios get different tenants",
);
for (const scenario of SCENARIOS) {
  assert(
    isTestPhone(testPhoneFor(scenario.name)),
    `scenario phone is in range: ${scenario.name}`,
  );
}
// Scenarios sharing a tenant would read each other's memo lines and wakeups,
// and the failure would look like a behavioural bug rather than a collision.
const phones = new Map<string, string>();
for (const scenario of SCENARIOS) {
  const phone = testPhoneFor(scenario.name);
  const taken = phones.get(phone);
  assert(!taken, `scenario phone collision: ${scenario.name} and ${taken}`);
  phones.set(phone, scenario.name);
}

// ------------------------------------------------- the transport-level sink
//
// Not everything Bro says to a person goes through `deliverHuman`. The welcome
// letter, the Telegram invite and the quota paywall are written straight to
// Photon with a conversation id and no tenant. Recording only at the
// `deliverHuman` layer left those invisible: against a test number the send
// failed, the caller's try/catch swallowed it, and a first-contact scenario
// saw silence. So the conversation id has to be reversible back to the tenant.

eq(
  testPhoneFromSpaceId(testSpaceId("+15555550101")),
  "+15555550101",
  "a test conversation id names its tenant",
);
for (const real of [
  "space-real",
  "",
  "test-space-",
  "test-space-+79161234567", // shaped like ours, but a real number
  undefined,
  null,
]) {
  assert(
    !testPhoneFromSpaceId(real as string | undefined),
    `a real conversation is not a test thread: ${String(real)}`,
  );
}

const photonSrc = src("agent/lib/photon.ts");
assert(
  photonSrc.includes("testPhoneFromSpaceId(opts.conversationId)"),
  "sendPhotonText records for a test thread instead of sending",
);
// Scoped to sendPhotonText's own body — `withSpectrum` is used by several
// functions above it, so a whole-file index comparison proves nothing.
const sendBody = photonSrc.slice(
  photonSrc.indexOf("export async function sendPhotonText"),
);
assert(
  sendBody.indexOf("testPhoneFromSpaceId(opts.conversationId)") <
    sendBody.indexOf("withSpectrum"),
  "the sink runs before Photon is contacted at all",
);
assert(
  photonSrc.includes("if (testPhoneFromSpaceId(conversationId)) return false"),
  "a test thread is never sent a typing indicator",
);
// The onboarding paths this exists for. If any of them stops going through
// sendPhotonText, it needs its own sink — and this check should fail first.
const onboardingSends = channelSrcForOnboarding();
for (const fn of ["sendWelcomeLetter", "sendTelegramInvite", "sendQuotaPaywall"]) {
  const body = onboardingSends(fn);
  assert(
    body.includes("sendPhotonText") || body.includes("deliverHuman"),
    `${fn} sends through a path the recorder covers`,
  );
}

// -------------------------------------------------- the synthetic inbound

const inboundBody = photonTestInbound({
  phone: "+15555550101",
  text: "привет",
});
const parsed = readPhotonInbound(inboundBody);
assert(parsed, "synthetic payload parses as a Photon inbound");
eq(parsed!.senderPhone, "+15555550101", "sender survives the round trip");
eq(parsed!.text, "привет", "text survives the round trip");
eq(parsed!.spaceId, testSpaceId("+15555550101"), "space id is the test thread");
assert(!parsed!.isEcho, "synthetic inbound is not an echo");
// An SMS-looking payload would be answered by the refusal branch instead of
// the agent, so the harness would be testing the wrong thing entirely.
assert(
  isBluePhotonService({ service: parsed!.service }),
  "synthetic inbound is on the blue path",
);

// ------------------------------------------------------------- the signature

const payload = JSON.stringify(inboundBody);
const signed = signSpectrumWebhook(payload, "webhook-secret");
assert(
  photonWebhookOk(
    Buffer.from(payload),
    new Headers({
      "x-spectrum-timestamp": signed.timestamp,
      "x-spectrum-signature": signed.signature,
    }),
    "webhook-secret",
  ),
  "signer round-trips through the verifier",
);
assert(
  !photonWebhookOk(
    Buffer.from(payload),
    new Headers({
      "x-spectrum-timestamp": signed.timestamp,
      "x-spectrum-signature": signed.signature,
    }),
    "another-secret",
  ),
  "a signature from the wrong secret is rejected",
);
assert(
  !photonWebhookOk(
    Buffer.from(`${payload} `),
    new Headers({
      "x-spectrum-timestamp": signed.timestamp,
      "x-spectrum-signature": signed.signature,
    }),
    "webhook-secret",
  ),
  "a tampered body is rejected",
);
const stale = signSpectrumWebhook(
  payload,
  "webhook-secret",
  Math.floor(Date.now() / 1000) - 3600,
);
assert(
  !photonWebhookOk(
    Buffer.from(payload),
    new Headers({
      "x-spectrum-timestamp": stale.timestamp,
      "x-spectrum-signature": stale.signature,
    }),
    "webhook-secret",
  ),
  "a replayed hour-old signature is rejected",
);

// ---------------------------------------------------------------- the sink

type Recorded = TestDelivery[];

async function deliverWith(tenant: {
  phoneE164?: string;
  photonConversationId?: string;
  telegramChatId?: string;
  lastChannel?: string;
}, text: string): Promise<{ recorded: Recorded; sentIMessage: string[]; sentTelegram: string[] }> {
  resetBubbleDedupe();
  const recorded: Recorded = [];
  const sentIMessage: string[] = [];
  const sentTelegram: string[] = [];
  await deliverHuman({
    tenant,
    text,
    deps: {
      recordTestDelivery: async (delivery) => {
        recorded.push(delivery);
      },
      sendIMessage: async ({ text: bubble }) => {
        sentIMessage.push(bubble);
      },
      sendTelegramMessage: (async ({ html }: { html: string }) => {
        sentTelegram.push(html);
      }) as never,
    },
  });
  return { recorded, sentIMessage, sentTelegram };
}

const testTenant = {
  phoneE164: "+15555550101",
  photonConversationId: testSpaceId("+15555550101"),
};
const recordedRun = await deliverWith(testTenant, "нашёл три варианта");
eq(recordedRun.recorded.length, 1, "test tenant outbound is recorded");
eq(recordedRun.recorded[0]!.text, "нашёл три варианта", "recorded text is what was said");
eq(recordedRun.recorded[0]!.channel, "imessage", "recorded on the iMessage channel");
// The whole point: nothing left the process.
eq(recordedRun.sentIMessage.length, 0, "test tenant never reaches Photon");
eq(recordedRun.sentTelegram.length, 0, "test tenant never reaches Telegram");

const realRun = await deliverWith(
  { phoneE164: "+79161234567", photonConversationId: "space-real" },
  "нашёл три варианта",
);
eq(realRun.recorded.length, 0, "a real tenant is never recorded");
eq(realRun.sentIMessage.length, 1, "a real tenant still gets the bubble");

// `lastChannel` still decides the channel for a test tenant, so a Telegram
// scenario records what Telegram would have shown, not the iMessage compile.
const telegramRun = await deliverWith(
  {
    phoneE164: "+15555550102",
    photonConversationId: testSpaceId("+15555550102"),
    telegramChatId: "9001",
    lastChannel: "telegram",
  },
  "**привет**",
);
eq(telegramRun.recorded.length, 1, "telegram test outbound is recorded");
eq(telegramRun.recorded[0]!.channel, "telegram", "recorded on the telegram channel");
eq(telegramRun.sentTelegram.length, 0, "test tenant never reaches the Telegram API");

// A test tenant with no conversation at all must still record rather than
// throw: a wakeup can fire before any inbound has bound a thread.
const unboundRun = await deliverWith({ phoneE164: "+15555550103" }, "напоминаю");
eq(unboundRun.recorded.length, 1, "an unbound test tenant still records");

// ------------------------------------------------------------ compiled form

// The recorded bubbles are the compiled form, not the model's markdown: a
// formatting regression (markdown leaking into iMessage, bold not surviving)
// has to be visible to a scenario, otherwise the suite can only ever test
// what Bro decided to say and never what the human would have seen.
const imessageBubbles = compileTestBubbles({
  phoneE164: "+15555550101",
  channel: "imessage",
  text: "**hello** бро",
});
eq(imessageBubbles.length, 1, "a short reply is one bubble");
assert(
  !imessageBubbles[0]!.includes("**"),
  "markdown is stripped before it is recorded",
);
assert(
  imessageBubbles[0]!.includes("\u{1D5F5}"),
  "latin bold survives as Unicode math-bold, the way the iPhone shows it",
);
const telegramBubbles = compileTestBubbles({
  phoneE164: "+15555550101",
  channel: "telegram",
  text: "**привет**",
});
assert(telegramBubbles.length >= 1, "telegram compiles to at least one chunk");
assert(
  telegramBubbles.join("").includes("<b>"),
  "telegram bubbles are the compiled HTML, not the markdown",
);

// -------------------------------------------------------------- the guards

const deliverSrc = src("agent/lib/deliver-human.ts");
assert(
  deliverSrc.includes("isTestPhone(tenant.phoneE164)"),
  "deliverHuman branches on the test range",
);
// The sink has to sit in front of the photo work: a recorded scenario must not
// hit Convex storage or a photo transport.
assert(
  deliverSrc.indexOf("isTestPhone(tenant.phoneE164)") <
    deliverSrc.indexOf("extractStoredFileRefs(cleaned)"),
  "the sink runs before any photo send",
);

const recorderSrc = src("convex/testTranscript.ts");
for (const fn of ["record", "list", "reset"]) {
  assert(recorderSrc.includes(`export const ${fn} =`), `recorder exposes ${fn}`);
}
eq(
  (recorderSrc.match(/assertTestPhone\(/g) ?? []).length,
  // once in the helper's own definition, then once per exported function
  4,
  "every recorder function refuses a phone outside the test range",
);
eq(
  (recorderSrc.match(/assertSecret\(/g) ?? []).length,
  3,
  "every recorder function is secret-gated",
);
// Reset is only useful if it clears what actually leaks between scenarios.
for (const table of ["testTranscript", "memories", "wakeups", "jobs"]) {
  assert(recorderSrc.includes(`"${table}"`), `reset clears ${table}`);
}
assert(recorderSrc.includes("browserNextTask: undefined"), "reset clears browser state");

const channelSrc = src("agent/channels/imessage.ts");
for (const route of ["/internal/test/transcript", "/internal/test/reset"]) {
  assert(channelSrc.includes(route), `route exists: ${route}`);
}
eq(
  (channelSrc.match(/not a test phone/g) ?? []).length,
  2,
  "both test routes refuse a phone outside the range",
);
assert(
  channelSrc.includes("from(testSpaceId(phone)).clear()"),
  "reset also clears the eve session, or a rerun starts mid-conversation",
);
// Inbound must stay on the production path — a second inbound route would be
// a copy that drifts.
assert(
  !channelSrc.includes("/internal/test/send"),
  "tests drive the real /webhooks/photon, not a test-only inbound route",
);

const tenantsSrc = src("convex/tenants.ts");
eq(
  (tenantsSrc.match(/isTestPhone\(phoneE164\)/g) ?? []).length,
  2,
  "message count and browser quota both skip test tenants",
);

console.log("test-tenant check ok");
