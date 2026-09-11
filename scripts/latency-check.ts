import { readFileSync, existsSync } from "node:fs";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const disabled = ["ask_question.ts"];
for (const file of disabled) {
  const src = readFileSync(new URL(`../agent/tools/${file}`, import.meta.url), "utf8");
  assert(src.includes("disableTool()"), `${file} disables a broken default`);
}

const kept = [
  "web_search.ts",
  "web_fetch.ts",
  "browser_task.ts",
  "composio.ts",
  "otp_lookup.ts",
  "job_open.ts",
  "job_wait.ts",
  "job_done.ts",
  "list_orders.ts",
  "bro_mail.ts",
  "vault_setup.ts",
  "profile_setup.ts",
  "schedule_wakeup.ts",
  "watch_app.ts",
  "imessage_react.ts",
  "telegram_react.ts",
  "send_photo.ts",
  "group_chat.ts",
];
for (const file of kept) {
  assert(
    existsSync(new URL(`../agent/tools/${file}`, import.meta.url)),
    `${file} still exists — Bro capabilities stay mounted`,
  );
}
assert(
  !readFileSync(new URL("../agent/tools/web_fetch.ts", import.meta.url), "utf8").includes(
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
  const jobs = readFileSync(
    new URL("../agent/instructions/jobs.ts", import.meta.url),
    "utf8",
  );
  assert(jobs.includes("isShortAckTurn"), "ack steer keys off this-turn stamp");
  assert(
    !jobs.includes("recallQuery(ctx.messages)"),
    "ack steer must not read Eve instruction history",
  );
}

const imessage = readFileSync(
  new URL("../agent/channels/imessage.ts", import.meta.url),
  "utf8",
);
assert(imessage.includes("imessageDeliveryEvents"), "iMessage shares delivery events");
assert(imessage.includes("prefetchOpenRouter"), "OpenRouter warms during billing, not after first token");

const telegram = readFileSync(
  new URL("../agent/channels/telegram.ts", import.meta.url),
  "utf8",
);
assert(telegram.includes("sendTelegramTyping"), "telegram shows typing like iMessage");
assert(telegram.includes("inboundP"), "telegram STT overlaps photo fetch");
assert(telegram.includes("parkTurn"), "human telegram turn is not awaited");
assert(
  !telegram.includes("telegramDeliveryEvents"),
  "telegram channel does not fire delivery events",
);
const telegramHook = readFileSync(
  new URL("../agent/hooks/telegram-deliver.ts", import.meta.url),
  "utf8",
);
assert(
  telegramHook.includes("telegramDeliveryEvents"),
  "telegram delivery lives on the root hook so old sessions still speak",
);

const telegramLib = readFileSync(
  new URL("../agent/lib/telegram.ts", import.meta.url),
  "utf8",
);
assert(telegramLib.includes("sendChatAction"), "typing uses Telegram chat action");
assert(telegramLib.includes("enqueueTelegramChat"), "telegram sends are serialized per chat");

const instructions = readFileSync(
  new URL("../agent/instructions.md", import.meta.url),
  "utf8",
);
assert(
  instructions.includes("write one short line") ||
    instructions.includes("напиши одну короткую") ||
    /write one short line the human can see first/i.test(instructions),
  "instructions ask for a visible line before tools",
);
assert(
  instructions.includes("Short acknowledgements") ||
    instructions.includes("короткие подтверждения"),
  "static prompt still tells the model short acks are real turns",
);
assert(
  /Poke \/ Tomo|Poke \/ Tomo short/.test(instructions) &&
    instructions.includes("## Voice"),
  "static prompt keeps Poke/Tomo-short voice",
);
assert(
  instructions.includes("1–2 short sentences") ||
    instructions.includes("1-2 short sentences"),
  "voice default is one or two sentences",
);

const archiveClient = readFileSync(
  new URL("../agent/lib/archive.ts", import.meta.url),
  "utf8",
);
assert(archiveClient.includes("/v4/search"), "archive Instinct search uses v4");
assert(archiveClient.includes('searchMode: "hybrid"'), "archive Instinct search is hybrid");
assert(
  archiveClient.includes("containerTag: archiveTag(phone)"),
  "archive search uses the singular v4 container",
);

console.log("latency-check ok");
