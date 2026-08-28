import {
  attachCallToJob,
  callTranscript,
  callWebhookUrl,
  decideCallRoute,
  flattenTranscript,
  formatCallWake,
  hostedReason,
  inkboxPlaceBody,
  isInkboxDialableE164,
  isRuE164,
  normalizeE164,
  parseCallEnded,
  parseCallEnv,
  pickClaimableLeg,
  zadarmaBridgeReply,
  zadarmaForwardNumber,
  zadarmaNotifyPayload,
} from "../convex/lib/callPolicy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(normalizeE164("8 (495) 123-45-67") === "+74951234567", "ru 8");
assert(normalizeE164("74951234567") === "+74951234567", "ru 7");
assert(normalizeE164("+1 (415) 555-0100") === "+14155550100", "us");
assert(normalizeE164("not-a-phone") === null, "junk");
assert(isRuE164("+74951234567"), "ru yes");
assert(!isRuE164("+14155550100"), "us no");
assert(isInkboxDialableE164("+14155550999"), "nanp yes");
assert(!isInkboxDialableE164("+74992816046"), "ru not inkbox dest");
assert(!isInkboxDialableE164("+447418353977"), "gb not inkbox dest");

const env = parseCallEnv({
  INKBOX_PHONE_NUMBER: "+14155550100",
  BRO_RU_BRIDGE_E164: "+14155550999",
  BRO_INKBOX_RU_ENABLED: "",
});
assert(env.ruBridgeE164 === "+14155550999", "bridge env");

const ru = decideCallRoute("8 495 123-45-67", env);
assert(ru.route === "ru_bridge", "ru uses bridge");
if (ru.route === "ru_bridge") {
  assert(ru.destE164 === "+74951234567", "ru dest kept");
  assert(ru.dialE164 === "+14155550999", "ru dials bridge");
}

const us = decideCallRoute("+14155550111", env);
assert(us.route === "inkbox_direct", "us direct");
if (us.route === "inkbox_direct") {
  assert(us.dialE164 === "+14155550111", "us dest is dial");
}

const directRu = decideCallRoute("+74951234567", {
  ...env,
  inkboxRuEnabled: true,
});
assert(directRu.route === "inkbox_direct", "flag skips bridge");

const blocked = decideCallRoute("+74951234567", {
  inkboxRuEnabled: false,
  ruBridgeE164: null,
  inkboxFromE164: "+14155550100",
  voxFromE164: null,
});
assert(blocked.route === "blocked", "no bridge no flag");

const ruBridge = decideCallRoute("+74951234567", {
  inkboxRuEnabled: false,
  ruBridgeE164: "+74992816046",
  inkboxFromE164: "+15189183436",
  voxFromE164: null,
});
assert(ruBridge.route === "blocked", "ru number is CLI not bridge");
if (ruBridge.route === "blocked") {
  assert(ruBridge.error.includes("Inkbox cannot dial +7"), "explain inkbox dest");
}

const voxCb = decideCallRoute("+74951234567", {
  inkboxRuEnabled: false,
  ruBridgeE164: null,
  inkboxFromE164: "+15189183436",
  voxFromE164: "+79001234567",
});
assert(voxCb.route === "vox_callback", "verified cli hairpin");
if (voxCb.route === "vox_callback") {
  assert(voxCb.destE164 === "+74951234567", "clinic dest kept");
  assert(voxCb.dialE164 === "+15189183436", "vox rings inkbox");
}

assert(
  decideCallRoute("+14155550100", env).route === "blocked",
  "no self call",
);

const body = inkboxPlaceBody({
  fromE164: "+14155550100",
  dialE164: "+14155550999",
  reason: "Забронируй на 20:00",
});
assert(body.mode === "hosted_agent", "hosted");
assert(body.to_number === "+14155550999", "dials bridge");
assert(body.voicemail_detection === "disabled", "ivr stays up");

assert(
  attachCallToJob(
    [{ id: "j1", status: "waiting", waitingFor: "call", callExternalId: "c1" }],
    "c1",
  ) === "j1",
  "attach by id",
);
assert(
  attachCallToJob(
    [{ id: "j2", status: "waiting", waitingFor: "call" }],
    null,
  ) === "j2",
  "attach singleton",
);

const wake = formatCallWake({
  jobId: "j1",
  callId: "c1",
  destE164: "+74951234567",
  route: "ru_bridge",
  status: "completed",
  durationSec: 42,
  outcome: "booked 20:30",
  transcript: "алло",
});
assert(wake.startsWith("[event:call]"), "tag");
assert(wake.includes("dest: +74951234567"), "dest in wake");

assert(
  callWebhookUrl("https://app.example/webhooks/imessage", "bro-a1b2c3d4") ===
    "https://app.example/webhooks/call?h=bro-a1b2c3d4",
  "call url",
);

const brief = hostedReason({
  destE164: "+74951234567",
  task: "стол на двоих в 20:00",
  callerName: "Иван",
});
assert(brief.includes("+74951234567"), "reason dest");
assert(brief.includes("Иван"), "reason name");
assert(brief.length <= 2000, "reason cap");

const picked = pickClaimableLeg(
  [
    { id: "old", createdAt: 0 },
    { id: "fresh", createdAt: 1_000_000 },
  ],
  1_000_000 + 1000,
);
assert(picked.staleIds.join() === "old", "stale pending");
assert(picked.claimId === "fresh", "fifo live");

const ended = parseCallEnded({
  event_type: "call.ended",
  data: {
    outcome: "completed",
    call: {
      id: "c9",
      remote_phone_number: "+14155550999",
      status: "completed",
      duration_seconds: 12,
    },
    post_call_action_items: [
      { action: "tell user", details: "booked 20:30" },
    ],
    transcript: {
      entries: [
        { party: "local", text: "алло" },
        { marker: "abridged" },
        { party: "remote", text: "да" },
      ],
    },
  },
});
assert(ended?.callId === "c9", "ended id");
assert(ended?.outcome?.includes("booked 20:30"), "action items");
assert(flattenTranscript({ entries: [{ party: "local", text: "hi" }] }) === "bro: hi", "flat");
assert(
  callTranscript({
    data: { transcript: { entries: [{ party: "remote", text: "ок" }] } },
  }) === "them: ок",
  "wake transcript",
);

assert(
  zadarmaNotifyPayload("15189183436", "14155550999", "2026-08-28 12:00:00") ===
    "15189183436141555509992026-08-28 12:00:00",
  "zadarma hmac payload",
);
assert(zadarmaForwardNumber("+74951234567") === "74951234567", "zadarma dest");
assert(zadarmaBridgeReply(null, "100").hangup === 1, "zadarma no pending");
const fwd = zadarmaBridgeReply("+74951234567", "100");
assert("rewrite_forward_number" in fwd, "zadarma rewrite");
if ("rewrite_forward_number" in fwd) {
  assert(fwd.redirect === "100", "zadarma ext");
  assert(fwd.rewrite_forward_number === "74951234567", "zadarma dest digits");
  assert(fwd.return_timeout === 0, "zadarma no bounce");
}

console.log("call-policy-check ok");
