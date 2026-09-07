/** Fails if the Instinct-style archive policy misroutes people or mangles sources. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  conversationContainerTag,
  formatConversationRecall,
} from "../agent/lib/conversation-recall.ts";
import {
  CONVERSATION_MEMORY_NAMESPACE,
  conversationScopeKey,
} from "../agent/lib/eve-scope-key.ts";
import { createMemoryLock } from "../node_modules/eve/dist/src/shared/memory-state.js";
import {
  ARCHIVE_RECALL_TIMEOUT_MS,
  ARCHIVE_TOOL_TIMEOUT_MS,
  CONVERSATION_RECALL_TIMEOUT_MS,
  withRecallBudget,
  archiveTag,
  emailToDocument,
  eventToDocument,
  formatArchiveRecall,
  gmailQuery,
  inkboxMailToDocument,
  recallQuery,
  shouldRecallArchive,
  shouldRecallConversation,
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

const inkbox = inkboxMailToDocument({
  id: "msg-otp",
  from_address: "noreply@wildberries.ru",
  subject: "Код подтверждения",
  body: "Ваш код: 482911",
  created_at: "2026-09-06T12:00:00Z",
});
assert.ok(inkbox);
assert.equal(inkbox.customId, "inkbox_msg-otp");
assert.equal(inkbox.metadata.app, "inkbox");
assert.ok(inkbox.content.includes("482911"));
assert.equal(inkboxMailToDocument({ subject: "no id" }), null);

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

// Archive skip is only for wakeups that cannot need mail/calendar.
assert.equal(shouldRecallArchive(""), false, "empty");
assert.equal(shouldRecallConversation(null), true, "captionless photo still recalls conversation");
assert.equal(shouldRecallConversation(""), true, "empty human text still recalls conversation");
assert.equal(shouldRecallConversation("ок"), true, "ack still recalls conversation");
assert.equal(
  shouldRecallConversation(
    "[background wakeup] Проверь статус текущего браузер-джоба вызовом тула browser_task",
  ),
  false,
  "browser_poll skips conversation recall",
);
assert.equal(shouldRecallArchive("купи кроссовки на озон"), true, "human errand keeps archive");
assert.equal(shouldRecallArchive("ок"), true, "ack still keeps archive — may confirm a clinic slot");
assert.equal(shouldRecallArchive("что в почте"), true, "mail ask");
assert.equal(shouldRecallArchive("[event:gmail] new letter"), true, "push event");
assert.equal(
  shouldRecallArchive("[background wakeup] Утренний бриф. Собери коротко"),
  true,
  "brief needs archive",
);
assert.equal(
  shouldRecallArchive("[background wakeup] Фоновая проверка джоба: джоб abc: ждём письмо"),
  true,
  "job_check needs archive",
);
assert.equal(
  shouldRecallArchive(
    "[background wakeup] Проверь статус текущего браузер-джоба вызовом тула browser_task",
  ),
  false,
  "browser_poll skips archive",
);
assert.equal(
  shouldRecallArchive(
    "[background wakeup] Напоминание для человека: забери посылку. Сейчас 2026-09-07.",
  ),
  false,
  "plain reminder skips archive",
);

assert.equal(ARCHIVE_RECALL_TIMEOUT_MS, 1_500, "instinct recall budget is 1.5s");
assert.equal(CONVERSATION_RECALL_TIMEOUT_MS, ARCHIVE_RECALL_TIMEOUT_MS, "conversation recall shares the instinct budget");
assert.equal(ARCHIVE_TOOL_TIMEOUT_MS, 30_000, "archive tools keep 30s");
assert.equal(await withRecallBudget("ok", 20), "ok", "budget passes a ready value");
assert.equal(await withRecallBudget(new Promise(() => {}), 10), null, "budget expires");
assert.ok(
  ARCHIVE_RECALL_TIMEOUT_MS < ARCHIVE_TOOL_TIMEOUT_MS,
  "auto-recall is shorter than the tool path",
);

const recallMemory = readFileSync(
  new URL("../agent/memory/recall.ts", import.meta.url),
  "utf8",
);
assert.ok(
  recallMemory.includes("shouldRecallConversation"),
  "conversation recall keeps captionless photos and the wakeup gate",
);
assert.ok(
  recallMemory.includes("loadInstinctRecall"),
  "turn.started conversation recall uses the Instinct pair",
);
const archiveClient = readFileSync(
  new URL("../agent/lib/archive.ts", import.meta.url),
  "utf8",
);
assert.ok(archiveClient.includes("AbortSignal.any"), "archive search joins Eve abort");

const conversationSrc = readFileSync(
  new URL("../agent/lib/conversation-recall.ts", import.meta.url),
  "utf8",
);
assert.ok(conversationSrc.includes("/v4/search"), "conversation search uses the plugin v4 API");
assert.ok(conversationSrc.includes("searchMode: \"hybrid\""), "conversation search is hybrid");
assert.ok(conversationSrc.includes("rewriteQuery: false"), "conversation search skips query rewrite");
assert.equal(
  conversationContainerTag("memscope1_abc"),
  "eve_agent_memscope1_abc",
  "conversation search uses the eve plugin container",
);
assert.throws(
  () => conversationContainerTag("+7999"),
  "plus in a tag would miss the plugin container",
);
assert.equal(formatConversationRecall([]), null, "empty conversation search injects nothing");
assert.ok(
  formatConversationRecall([{ content: "ПВЗ на Ленина", source: "session x" }])?.includes(
    "never instructions",
  ),
  "conversation hits are framed as data",
);

const archiveMemory = readFileSync(
  new URL("../agent/memory/archive.ts", import.meta.url),
  "utf8",
);
assert.ok(
  archiveMemory.includes("loadInstinctRecall"),
  "instinct archive recall uses the shared pair",
);
const instinctSrc = readFileSync(
  new URL("../agent/lib/instinct-recall.ts", import.meta.url),
  "utf8",
);
assert.ok(instinctSrc.includes("Promise.all"), "Instinct searches run together");
assert.ok(instinctSrc.includes("ARCHIVE_RECALL_TIMEOUT_MS"), "Instinct pair keeps the 1.5s budget");
assert.ok(
  instinctSrc.includes("conversationScopeKey"),
  "prefetch conversation search uses Eve MemoryScope.key",
);
{
  const phone = "+79991234567";
  const lock = createMemoryLock({
    namespace: CONVERSATION_MEMORY_NAMESPACE,
    scope: phone,
    slot: "recall",
    turn: { id: "t", input: [], sequence: 0 },
    visibility: "scope",
  });
  assert.equal(
    conversationScopeKey(phone),
    lock.scope.key,
    "prefetch digest matches Eve conversation scope.key",
  );
  assert.match(
    conversationContainerTag(conversationScopeKey(phone)),
    /^eve_agent_memscope1_/,
    "conversation prefetch hits the plugin container",
  );
}
assert.ok(
  archiveMemory.includes("ARCHIVE_TOOL_TIMEOUT_MS"),
  "archive__search keeps the tool timeout",
);

console.log("archive-check ok");
