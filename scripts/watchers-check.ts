import { createHmac } from "node:crypto";
import {
  EVENT_TTL_MS,
  MAX_DELIVERY_ATTEMPTS,
  TEXT_CAP,
  WATCH_SOURCES,
  WEBHOOK_TOLERANCE_S,
  deliveryBackoffMs,
  describeWatcher,
  eventPayload,
  eventPrompt,
  formatEvent,
  hmacSha256Base64,
  isWatchSource,
  ownsEvent,
  parseComposioEvent,
  shouldRetryDelivery,
  signatureMatches,
  timestampFresh,
  triggerSpec,
  verifyComposioWebhook,
} from "../convex/lib/watcherPolicy.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const gmailSpec = triggerSpec("gmail");
assert(gmailSpec.slug === "GMAIL_NEW_GMAIL_MESSAGE", "gmail slug");
assert(gmailSpec.toolkit === "gmail", "gmail toolkit");
assert(gmailSpec.config.labelIds === "INBOX", "gmail default labelIds INBOX");
assert(gmailSpec.config.interval === 1, "gmail interval 1");
assert(!("query" in gmailSpec.config), "gmail default has no query");

const gmailFiltered = triggerSpec("gmail", " from:bank.ru ");
assert(gmailFiltered.config.query === "from:bank.ru", "gmail filter trims query");
assert(!("labelIds" in gmailFiltered.config), "gmail filter has no labelIds");

const calSpec = triggerSpec("calendar");
assert(
  calSpec.slug === "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER",
  "calendar slug",
);
assert(calSpec.toolkit === "googlecalendar", "calendar toolkit");
assert(calSpec.config.calendarId === "primary", "calendarId primary");
assert(calSpec.config.showDeleted === true, "calendar showDeleted");

assert(isWatchSource("gmail"), "isWatchSource gmail");
assert(isWatchSource("calendar"), "isWatchSource calendar");
assert(!isWatchSource("slack"), "isWatchSource slack false");
assert(WATCH_SOURCES.length === 2, "WATCH_SOURCES length 2");

const hmacMsg = "msg_1.1700000000.{}";
const hmacNode = createHmac("sha256", "whsec_test").update(hmacMsg).digest("base64");
const hmacPolicy = await hmacSha256Base64("whsec_test", hmacMsg);
assert(hmacPolicy === hmacNode, `HMAC mismatch policy=${hmacPolicy} node=${hmacNode}`);

assert(signatureMatches("v1,AAA v1,BBB", "BBB"), "signature any v1 match");
assert(!signatureMatches("v1,AAA", "BBB"), "signature no match");
assert(!signatureMatches("v2,BBB", "BBB"), "signature ignores v2");
assert(!signatureMatches("", "BBB"), "empty signature header");

const nowMs = 1_700_000_000_000;
const nowTs = String(Math.floor(nowMs / 1000));
assert(timestampFresh(nowTs, nowMs), "timestamp exactly now");
assert(timestampFresh(String(Math.floor(nowMs / 1000) - 299), nowMs), "timestamp now-299s");
assert(
  !timestampFresh(String(Math.floor(nowMs / 1000) - 301), nowMs),
  "timestamp now-301s stale",
);
assert(!timestampFresh("abc", nowMs), "timestamp garbage");
assert(
  timestampFresh(String(Math.floor(nowMs / 1000) + 200), nowMs),
  "timestamp future +200s",
);

const secret = "whsec_e2e";
const webhookId = "msg_e2e";
const tsSec = 1_700_000_000;
const body = JSON.stringify({
  id: "msg_e2e",
  type: "composio.trigger.message",
  metadata: {
    trigger_id: "ti_e2e",
    trigger_slug: "gmail_new_gmail_message",
    user_id: "+79990000000",
    connected_account_id: "ca_e2e",
  },
  data: { subject: "hi" },
});
const signed = `${webhookId}.${tsSec}.${body}`;
const sigB64 = createHmac("sha256", secret).update(signed).digest("base64");
const header = `v1,${sigB64}`;
const e2eNow = tsSec * 1000;

assert(
  await verifyComposioWebhook({
    id: webhookId,
    timestamp: String(tsSec),
    signature: header,
    body,
    secret,
    nowMs: e2eNow,
  }),
  "verifyComposioWebhook valid V3",
);

const tampered = body.replace("hi", "hI");
assert(
  !(await verifyComposioWebhook({
    id: webhookId,
    timestamp: String(tsSec),
    signature: header,
    body: tampered,
    secret,
    nowMs: e2eNow,
  })),
  "verifyComposioWebhook tampered body",
);

assert(
  !(await verifyComposioWebhook({
    id: webhookId,
    timestamp: String(tsSec),
    signature: header,
    body,
    secret: "",
    nowMs: e2eNow,
  })),
  "verifyComposioWebhook empty secret",
);

assert(
  !(await verifyComposioWebhook({
    id: webhookId,
    timestamp: String(tsSec - 400),
    signature: `v1,${createHmac("sha256", secret).update(`${webhookId}.${tsSec - 400}.${body}`).digest("base64")}`,
    body,
    secret,
    nowMs: e2eNow,
  })),
  "verifyComposioWebhook stale timestamp",
);

const dualHeader = `v1,AAAA ${header}`;
assert(
  await verifyComposioWebhook({
    id: webhookId,
    timestamp: String(tsSec),
    signature: dualHeader,
    body,
    secret,
    nowMs: e2eNow,
  }),
  "verifyComposioWebhook second signature valid",
);

const v3 = parseComposioEvent(
  JSON.stringify({
    id: "msg_1",
    type: "composio.trigger.message",
    metadata: {
      trigger_id: "ti_1",
      trigger_slug: "gmail_new_gmail_message",
      user_id: "+79990000000",
      connected_account_id: "ca_1",
    },
    data: { subject: "hi" },
  }),
);
assert(v3 !== null, "parse V3 not null");
assert(v3.eventId === "msg_1", "V3 eventId");
assert(v3.triggerId === "ti_1", "V3 triggerId");
assert(v3.triggerSlug === "GMAIL_NEW_GMAIL_MESSAGE", "V3 slug upper");
assert(v3.userId === "+79990000000", "V3 userId");
assert(v3.connectedAccountId === "ca_1", "V3 connectedAccountId");
assert(v3.data.subject === "hi", "V3 data.subject");

assert(
  parseComposioEvent(
    JSON.stringify({ type: "composio.connected_account.expired" }),
  ) === null,
  "V3 non-trigger type null",
);

const v3Fallback = parseComposioEvent(
  JSON.stringify({
    type: "composio.trigger.message",
    metadata: { trigger_id: "ti_9", trigger_slug: "gmail_new_gmail_message" },
    data: {},
  }),
  "wh_9",
);
assert(v3Fallback?.eventId === "wh_9", "V3 eventId from webhookId");

const v2 = parseComposioEvent(
  JSON.stringify({
    type: "gmail_new_gmail_message",
    data: {
      trigger_id: "ti_2",
      user_id: "+7",
      connection_id: "ca_2",
      subject: "v2",
    },
    log_id: "log_2",
  }),
);
assert(v2 !== null, "parse V2 not null");
assert(v2.triggerSlug === "GMAIL_NEW_GMAIL_MESSAGE", "V2 slug upper");
assert(v2.eventId === "log_2", "V2 eventId log_id");
assert(v2.data.subject === "v2", "V2 data.subject");
assert(!("trigger_id" in v2.data), "V2 data strips trigger_id");

const v1 = parseComposioEvent(
  JSON.stringify({
    trigger_name: "gmail_new_gmail_message",
    trigger_id: "ti_3",
    connection_id: "ca_3",
    payload: { subject: "v1" },
    log_id: "log_3",
  }),
);
assert(v1 !== null, "parse V1 not null");
assert(v1.triggerSlug === "GMAIL_NEW_GMAIL_MESSAGE", "V1 slug");
assert(v1.triggerId === "ti_3", "V1 triggerId");
assert(v1.eventId === "log_3", "V1 eventId");
assert(v1.data.subject === "v1", "V1 payload subject");

assert(parseComposioEvent("not json") === null, "invalid JSON null");
assert(parseComposioEvent("{}") === null, "empty object null");
assert(
  parseComposioEvent(
    JSON.stringify({
      type: "composio.trigger.message",
      metadata: { trigger_id: "ti_x", trigger_slug: "gmail_new_gmail_message" },
      data: {},
    }),
  ) === null,
  "V3 missing id and webhookId null",
);

const gmailFormatted = formatEvent("GMAIL_NEW_GMAIL_MESSAGE", {
  sender: "bank@x",
  subject: "hi",
  message_timestamp: "2026-01-01",
  message_id: "m1",
  thread_id: "t1",
  message_text: "hello",
});
assert(gmailFormatted.startsWith("[event:gmail]"), "gmail format prefix");
assert(gmailFormatted.includes("от: "), "gmail from line");
assert(gmailFormatted.includes("тема: "), "gmail subject line");
assert(gmailFormatted.includes("текст:"), "gmail text line");

const longText = "x".repeat(3000);
const capped = formatEvent("GMAIL_NEW_GMAIL_MESSAGE", { message_text: longText });
assert(capped.length < 1800, `gmail 3000-char text capped, got ${capped.length}`);
assert(capped.includes("…"), "gmail cap ellipsis");
assert(TEXT_CAP === 1500, "TEXT_CAP 1500");

const noBody = formatEvent("GMAIL_NEW_GMAIL_MESSAGE", { subject: "only" });
assert(!noBody.includes("текст:"), "gmail without message_text has no текст:");

const calFormatted = formatEvent(
  "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER",
  {
    event_type: "created",
    summary: "standup",
    start_time: "2026-01-01T09:00:00Z",
    attendees: [{ email: "a@x" }, { email: "b@x" }],
  },
);
assert(calFormatted.startsWith("[event:calendar]"), "calendar prefix");
assert(calFormatted.includes("изменение: created"), "calendar event_type");
assert(calFormatted.includes("участники: a@x, b@x"), "calendar attendees");

const other = formatEvent("FOO_BAR", { a: 1 });
assert(other.startsWith("[event:foo_bar]"), "unknown slug prefix");
assert(other.includes('"a":1'), "unknown slug json");

const payload = eventPayload("письма от банка", "[event:gmail]\nтема: x");
assert(payload.startsWith("Сторож: письма от банка"), "eventPayload prefix");
assert(payload.includes("[event:gmail]"), "eventPayload contains event text");

const prompt = eventPrompt("p");
assert(prompt.startsWith("[background wakeup] p"), "eventPrompt prefix");
assert(prompt.includes("[SILENT]"), "eventPrompt SILENT");
assert(prompt.includes("данные"), "eventPrompt данные");

assert(
  ownsEvent({ tenantPhone: "+7", status: "active" }, { userId: "+7" }),
  "ownsEvent same user",
);
assert(
  ownsEvent({ tenantPhone: "+7", status: "active" }, {}),
  "ownsEvent missing userId",
);
assert(
  !ownsEvent({ tenantPhone: "+7", status: "active" }, { userId: "+8" }),
  "ownsEvent other user",
);
assert(
  !ownsEvent({ tenantPhone: "+7", status: "stopped" }, { userId: "+7" }),
  "ownsEvent stopped",
);

assert(deliveryBackoffMs(0) === 30_000, "backoff 0");
assert(deliveryBackoffMs(1) === 60_000, "backoff 1");
assert(deliveryBackoffMs(2) === 120_000, "backoff 2");
assert(shouldRetryDelivery(0), "retry attempt 0");
assert(shouldRetryDelivery(1), "retry attempt 1");
assert(!shouldRetryDelivery(2), "no retry attempt 2");
assert(MAX_DELIVERY_ATTEMPTS === 3, "MAX_DELIVERY_ATTEMPTS");
assert(EVENT_TTL_MS === 86_400_000, "EVENT_TTL_MS");
assert(WEBHOOK_TOLERANCE_S === 300, "WEBHOOK_TOLERANCE_S");

assert(
  describeWatcher({
    _id: "w1",
    source: "gmail",
    about: "банк",
    filter: "from:bank",
    events: 2,
  }) === "w1 gmail: банк (фильтр: from:bank), событий: 2",
  "describeWatcher full",
);
assert(
  describeWatcher({ _id: "w1", source: "gmail", about: "банк" }) ===
    "w1 gmail: банк",
  "describeWatcher bare",
);

console.log("watchers-check ok");
