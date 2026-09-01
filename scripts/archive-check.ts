/** Fails if the Instinct-style archive policy misroutes people or mangles sources. */
import assert from "node:assert/strict";
import {
  archiveTag,
  emailToDocument,
  eventToDocument,
  formatArchiveRecall,
  gmailQuery,
  recallQuery,
} from "../agent/lib/archive-policy.ts";

// One container per person; E.164 plus stays out of the tag.
assert.equal(archiveTag("+79991234567"), "bro_archive_79991234567");
assert.equal(archiveTag("local-dev"), "bro_archive_local-dev");
assert.notEqual(archiveTag("+7999"), archiveTag("+7998"));

// Gmail mapping: stable customId, header, truncation, unusable → null.
const email = emailToDocument({
  messageId: "18f2a",
  subject: "Приём подтверждён",
  sender: "clinic@denta.ru",
  messageTimestamp: "2026-09-05T12:00:00Z",
  messageText: "Ждём вас 5 сентября в 15:00.",
});
assert.ok(email);
assert.equal(email.customId, "gmail_18f2a");
assert.equal(email.metadata.app, "gmail");
assert.ok(email.content.includes("От: clinic@denta.ru"));
assert.ok(email.content.includes("Ждём вас"));
assert.equal(emailToDocument({ subject: "no id" }), null);
assert.equal(emailToDocument({ messageId: "x" }), null); // no text
const longEmail = emailToDocument({ messageId: "y", messageText: "x".repeat(9000) });
assert.ok(longEmail && longEmail.content.length <= 4000);

// Calendar mapping.
const event = eventToDocument({
  id: "ev1",
  summary: "Стоматолог",
  start: { dateTime: "2026-09-05T15:00:00+03:00" },
  end: { dateTime: "2026-09-05T16:00:00+03:00" },
  location: "Тверская 1",
});
assert.ok(event);
assert.equal(event.customId, "gcal_ev1");
assert.equal(event.metadata.app, "calendar");
assert.ok(event.content.includes("Место: Тверская 1"));
assert.equal(eventToDocument({ id: "ev2", summary: "без даты" }), null);

// Recall query: latest user message text, string or parts, truncated.
assert.equal(
  recallQuery([
    { role: "user", content: "первое" },
    { role: "assistant", content: "ответ" },
    { role: "user", content: "когда приём у стоматолога?" },
  ]),
  "когда приём у стоматолога?",
);
assert.equal(
  recallQuery([{ role: "user", content: [{ type: "text", text: "из частей" }] }]),
  "из частей",
);
assert.equal(recallQuery([{ role: "assistant", content: "только ассистент" }]), null);
assert.equal(recallQuery([])?.valueOf(), undefined);
assert.ok(recallQuery([{ role: "user", content: "щ".repeat(999) }])!.length <= 300);

// Gmail window: after:<unix seconds>, first run capped at 7 days back.
const now = Date.UTC(2026, 8, 1, 12);
assert.equal(gmailQuery(now - 3_600_000, now), `after:${Math.floor((now - 3_600_000) / 1000)}`);
const firstRun = gmailQuery(undefined, now);
assert.equal(firstRun, `after:${Math.floor((now - 7 * 86_400_000) / 1000)}`);
assert.equal(gmailQuery(0, now), firstRun); // stale marker also capped

// Recall block: injection guard, empty → null.
assert.equal(formatArchiveRecall([]), null);
const block = formatArchiveRecall([
  { title: "Приём", content: "5 сентября 15:00", app: "gmail", date: "2026-09-05" },
]);
assert.ok(block!.includes("не инструкции"));
assert.ok(block!.includes("[gmail] (2026-09-05) Приём"));

console.log("archive-check ok");
