import { readFileSync } from "node:fs";
import {
  isBluePhotonService,
  normalizePhotonE164,
  outboundIMessageConversation,
  photonBasicAuthHeader,
  photonNudgeText,
  photonOnboardLink,
  PHOTON_SHARED_NUMBER,
  photonSmsLink,
  refuseSmsText,
  shouldNudgeInkboxThread,
} from "../convex/lib/photonPolicy.ts";
import { photonWebhookOk, readPhotonInbound } from "../agent/lib/photon.ts";
import { shouldSkipAgentTurn } from "../agent/lib/onboard-policy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(isBluePhotonService({ service: "iMessage" }), "imessage is blue");
assert(isBluePhotonService({ service: undefined }), "missing service is blue");
assert(!isBluePhotonService({ service: "sms" }), "sms is refused");
assert(!isBluePhotonService({ service: "rcs" }), "rcs is refused");
assert(!isBluePhotonService({ wasDowngraded: true }), "downgrade is refused");

assert(
  photonBasicAuthHeader("proj", "s3cret") ===
    `Basic ${Buffer.from("proj:s3cret").toString("base64")}`,
  "basic auth matches node Buffer",
);
assert(
  photonBasicAuthHeader("id", "пароль") ===
    `Basic ${Buffer.from("id:пароль").toString("base64")}`,
  "basic auth encodes utf8 like Buffer",
);
{
  const saved = globalThis.Buffer;
  // @ts-expect-error -- prove the helper does not touch Buffer
  delete globalThis.Buffer;
  try {
    assert(
      photonBasicAuthHeader("proj", "s3cret") ===
        `Basic ${saved.from("proj:s3cret").toString("base64")}`,
      "basic auth works without Buffer (Convex default runtime)",
    );
  } finally {
    globalThis.Buffer = saved;
  }
}

assert(normalizePhotonE164("+79001112233") === "+79001112233", "e164 passthrough");
assert(normalizePhotonE164("89001112233") === "+79001112233", "8 → +7");
assert(normalizePhotonE164("not") === undefined, "garbage");

assert(photonSmsLink("+15551212").startsWith("sms:"), "sms deep link");
assert(PHOTON_SHARED_NUMBER === "+16282649335", "shared Bro number");
assert(
  photonOnboardLink() === "sms:+16282649335&body=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82",
  "onboard link is Bro's iMessage sms: deep link",
);
assert(
  photonOnboardLink() === photonSmsLink(PHOTON_SHARED_NUMBER),
  "onboard link uses the shared number",
);
const configJs = readFileSync(new URL("../assets/config.js", import.meta.url), "utf8");
assert(configJs.includes(photonOnboardLink()), "config.js ships the same iMessage link");
const landingHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
assert(landingHtml.includes(photonOnboardLink()), "landing CTA href is the iMessage link");
assert(!landingHtml.includes("access-phone"), "landing has no phone field");
assert(!landingHtml.includes("/access"), "landing CTA does not POST /access");
assert(landingHtml.includes("Открой на iPhone"), "desktop keeps the iPhone hint");
assert(refuseSmsText().toLowerCase().includes("sms"), "refuse copy");
assert(photonNudgeText("+1555").includes("+1555"), "nudge has number");

assert(
  outboundIMessageConversation({
    requested: "ink-1",
    photonConversationId: "ph-1",
    inkboxConversationId: "ink-1",
  }) === "ph-1",
  "never outbound to the old Inkbox thread",
);
assert(
  outboundIMessageConversation({ photonConversationId: "ph-1" }) === "ph-1",
  "photon id is the chat",
);
assert(
  shouldNudgeInkboxThread({ photonConversationId: "ph-1" }) === "ignore-bound",
  "already on Photon",
);
assert(shouldNudgeInkboxThread({ photonNudgeSentAt: 1 }) === "drop", "nudge once");
assert(shouldNudgeInkboxThread({}) === "nudge", "unbound old thread");

const inbound = readPhotonInbound({
  event: "message.received",
  space: { id: "space-1", assignedPhoneNumber: "+15551212" },
  message: {
    id: "m1",
    sender: { address: "+79001112233", service: "iMessage" },
    content: { type: "text", text: "привет" },
  },
});
assert(inbound?.spaceId === "space-1", "parse space");
assert(inbound?.senderPhone === "+79001112233", "parse sender");
assert(inbound?.text === "привет", "parse text");

const sms = readPhotonInbound({
  space: { id: "space-1" },
  message: {
    sender: { address: "+79001112233", service: "sms" },
    content: { type: "text", text: "hi" },
  },
});
assert(sms?.service === "sms", "sms inbound is visible so the channel can refuse");

const secret = "test-secret";
const ts = String(Math.floor(Date.now() / 1000));
const body = '{"space":{"id":"s"}}';
const { createHmac } = await import("node:crypto");
const hex = createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
const headers = new Headers({
  "x-spectrum-timestamp": ts,
  "x-spectrum-signature": `v0=${hex}`,
});
assert(photonWebhookOk(Buffer.from(body), headers, secret), "hmac ok");
assert(
  !photonWebhookOk(Buffer.from(body), new Headers({
    "x-spectrum-timestamp": ts,
    "x-spectrum-signature": "v0=deadbeef",
  }), secret),
  "hmac rejects bad sig",
);

const channel = readFileSync(new URL("../agent/channels/imessage.ts", import.meta.url), "utf8");
assert(channel.includes("/webhooks/photon"), "photon route");
assert(channel.includes("/internal/photon-send"), "cabinet OTP route");
assert(channel.includes("sendPhotonText"), "outbound Photon");
assert(channel.includes("photonNudgeText"), "Inkbox nudge");
assert(!channel.includes("bindGroupInbound"), "no group bind on Pro");
assert(
  !channel.includes("allowlisted(inbound.senderPhone)"),
  "Photon DMs are not gated by ALLOWED_SENDERS",
);
assert(
  !/\+79\d{9}/.test(channel),
  "Photon channel has no hardcoded tenant phone",
);
assert(
  shouldSkipAgentTurn({ firstBind: true, text: "привет" }),
  "first привет is canned welcome+help, not a silent drop",
);
assert(
  !shouldSkipAgentTurn({ firstBind: false, text: "запиши к врачу завтра" }),
  "later errand is an agent turn for every bound tenant",
);

const deliver = readFileSync(new URL("../agent/lib/deliver-human.ts", import.meta.url), "utf8");
assert(deliver.includes("sendPhotonText"), "deliver-human uses Photon");
assert(deliver.includes("outboundIMessageConversation"), "never sends to Inkbox chat id");

const access = readFileSync(new URL("../convex/access.ts", import.meta.url), "utf8");
assert(access.includes("need_phone"), "access API can still ask for E.164");
assert(access.includes("upsertPhotonSharedUser"), "access can still mint a Photon user");
assert(
  !readFileSync(new URL("../convex/lib/photonRest.ts", import.meta.url), "utf8").includes(
    "Buffer.",
  ),
  "photonRest stays Convex-runtime safe (no Buffer)",
);

const dedicated = readFileSync(
  new URL("../convex/lib/dedicatedLinePolicy.ts", import.meta.url),
  "utf8",
);
assert(dedicated.includes("imessage_enabled: false"), "new identities are mail-only");

const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
assert(pkg.includes("photon:check"), "npm script");
assert(pkg.includes("spectrum-ts"), "spectrum-ts dependency");
assert(pkg.includes('"@grpc/grpc-js"'), "grpc peer is a direct dep");
assert(pkg.includes('"nice-grpc"'), "nice-grpc is a direct dep");
assert(pkg.includes('"nice-grpc-common"'), "nice-grpc-common is a direct dep");

const photonSrc = readFileSync(new URL("../agent/lib/photon.ts", import.meta.url), "utf8");
assert(photonSrc.includes('import "@grpc/grpc-js"'), "photon pins grpc-js");
assert(photonSrc.includes('import "nice-grpc"'), "photon pins nice-grpc");
assert(photonSrc.includes('import "nice-grpc-common"'), "photon pins nice-grpc-common");
assert(!/\+79\d{9}/.test(photonSrc), "sendPhotonText has no hardcoded phone");
assert(
  photonSrc.includes("opts.conversationId") && photonSrc.includes("im.space.get"),
  "outbound is conversation-id based for every tenant",
);

const agentSrc = readFileSync(new URL("../agent/agent.ts", import.meta.url), "utf8");
assert(agentSrc.includes("externalDependencies"), "eve traces Photon gRPC peers");
assert(agentSrc.includes('"@grpc/grpc-js"'), "agent traces grpc-js");
assert(agentSrc.includes('"nice-grpc"'), "agent traces nice-grpc");
assert(agentSrc.includes('"nice-grpc-common"'), "agent traces nice-grpc-common");

console.log("photon-check ok");
