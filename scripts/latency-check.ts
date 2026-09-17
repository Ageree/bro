import { existsSync } from "node:fs";

import { assert, src } from "./lib/check.ts";

const disabled = ["ask_question.ts"];
for (const file of disabled) {
  const toolSrc = src(`agent/tools/${file}`);
  assert(toolSrc.includes("disableTool()"), `${file} disables a broken default`);
}

const kept = [
  "web_search.ts",
  "web_fetch.ts",
  "browser_task.ts",
  "composio.ts",
  "otp_lookup.ts",
  "job.ts",
  "list_orders.ts",
  "bro_mail.ts",
  "vault_setup.ts",
  "profile_setup.ts",
  "schedule_wakeup.ts",
  "watch_app.ts",
  "imessage_react.ts",
  "telegram_react.ts",
  "send_photo.ts",
];
for (const file of kept) {
  assert(
    existsSync(new URL(`../agent/tools/${file}`, import.meta.url)),
    `${file} still exists — Bro capabilities stay mounted`,
  );
}
assert(
  !src("agent/tools/web_fetch.ts").includes(
    "disableTool()",
  ),
  "web_fetch is TinyFish, not the disabled eve default",
);

assert(
  !existsSync(new URL("../agent/tools/agent.ts", import.meta.url)),
  "recursive agent tool is not disabled — capability kept",
);
assert(
  !existsSync(new URL("../agent/lib/instant-ack.ts", import.meta.url)),
  "no instant-ack skip — ок/спасибо still run the agent (open jobs)",
);
assert(
  existsSync(new URL("../agent/lib/short-ack.ts", import.meta.url)),
  "short acks steer the model, they do not skip the agent",
);
{
  const jobs = src("agent/instructions/jobs.ts");
  assert(jobs.includes("isShortAckTurn"), "ack steer keys off this-turn stamp");
  assert(
    !jobs.includes("recallQuery(ctx.messages)"),
    "ack steer must not read Eve instruction history",
  );
}

const imessage = src("agent/channels/imessage.ts");
assert(imessage.includes("imessageDeliveryEvents"), "iMessage shares delivery events");
assert(imessage.includes("prefetchOpenRouter"), "OpenRouter warms during billing, not after first token");

const telegram = src("agent/channels/telegram.ts");
assert(telegram.includes("sendTelegramTyping"), "telegram shows typing like iMessage");
assert(telegram.includes("parkTurn"), "human telegram turn is not awaited");
assert(
  !telegram.includes("telegramDeliveryEvents"),
  "telegram channel does not fire delivery events",
);
const telegramHook = src("agent/hooks/telegram-deliver.ts");
assert(
  telegramHook.includes("telegramDeliveryEvents"),
  "telegram delivery lives on the root hook so old sessions still speak",
);

const telegramLib = src("agent/lib/telegram.ts");
assert(telegramLib.includes("sendChatAction"), "typing uses Telegram chat action");
assert(telegramLib.includes("enqueueTelegramChat"), "telegram sends are serialized per chat");

const instructions = src("agent/instructions.md");
assert(
  /Перед инструментом[^.]*одна короткая строка/i.test(instructions) ||
    instructions.includes("write one short line") ||
    instructions.includes("напиши одну короткую"),
  "instructions ask for a visible line before tools",
);
// Short acks used to be a sentence in the static prompt. They are now a turn
// verdict (`agent/lib/turn-voice.ts`), which is strictly better: the static
// sentence could not tell an idle «ок» from one that answers a waiting job,
// and acking the second one back stalls the job. Follow the rule to its home.
{
  const voice = src("agent/lib/turn-voice.ts");
  assert(voice.includes('"ack_only"'), "an idle short ack has its own verdict");
  assert(
    voice.includes('"ack_confirms"'),
    "an ack answering a waiting job has its own verdict",
  );
}
// The register, not the reference points. The prompt used to name Poke and
// Tomo as shorthand for "text like that"; the brands mean nothing to the model
// on their own, so what is checked is the property they stood for.
assert(
  instructions.includes("## Voice") &&
    /1–2 short sentences|never a chatbot essay/i.test(instructions) &&
    /Пиши, как он: длина, регистр/.test(instructions),
  "static prompt keeps the short-texting voice",
);
assert(
  instructions.includes("1–2 short sentences") ||
    instructions.includes("1-2 short sentences"),
  "voice default is one or two sentences",
);

const archiveClient = src("agent/lib/archive.ts");
assert(archiveClient.includes("/v4/search"), "archive Instinct search uses v4");
assert(archiveClient.includes('searchMode: "hybrid"'), "archive Instinct search is hybrid");
assert(
  archiveClient.includes("containerTag: archiveTag(phone)"),
  "archive search uses the singular v4 container",
);

console.log("latency-check ok");
