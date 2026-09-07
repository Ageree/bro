import { readFileSync, existsSync } from "node:fs";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const disabled = ["ask_question.ts", "web_fetch.ts"];
for (const file of disabled) {
  const src = readFileSync(new URL(`../agent/tools/${file}`, import.meta.url), "utf8");
  assert(src.includes("disableTool()"), `${file} disables a broken default`);
}

const kept = [
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
  "group_chat.ts",
];
for (const file of kept) {
  assert(
    existsSync(new URL(`../agent/tools/${file}`, import.meta.url)),
    `${file} still exists — Bro capabilities stay mounted`,
  );
}

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
assert(imessage.includes("routingFromAuth"), "first bubble uses auth routing");
assert(imessage.includes("deliverTurnBubble"), "delivery helper is shared");
assert(imessage.includes("prefetchOpenRouter"), "OpenRouter warms during billing, not after first token");
assert(imessage.includes('"message.appended"'), "first iMessage bubble can leave before the step ends");
assert(imessage.includes("planStreamFlush"), "streamed flush is newline-gated");
assert(imessage.includes("planPreToolFlush"), "pre-tool flush covers a line with no newline");
assert(imessage.includes("void deliverTurnBubble"), "early iMessage send does not block tools");

const telegram = readFileSync(
  new URL("../agent/channels/telegram.ts", import.meta.url),
  "utf8",
);
assert(telegram.includes("sendTelegramTyping"), "telegram shows typing like iMessage");
assert(telegram.includes("inboundP"), "telegram STT overlaps photo fetch");
assert(telegram.includes("parkTurn"), "human telegram turn is not awaited");
assert(
  !telegram.includes('"message.completed"'),
  "telegram must not copy delivery events — that would double-send",
);
assert(
  !telegram.includes('"message.appended"'),
  "telegram must not copy streamed delivery — that would double-send",
);

const telegramLib = readFileSync(
  new URL("../agent/lib/telegram.ts", import.meta.url),
  "utf8",
);
assert(telegramLib.includes("sendChatAction"), "typing uses Telegram chat action");

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

console.log("latency-check ok");
