import { readFileSync } from "node:fs";
import {
  broVcard,
  helpText,
  isConnectOrEmptyInbound,
  isHelpAsk,
  isTelegramAsk,
  shouldSkipAgentTurn,
  welcomeBubbles,
  welcomeText,
} from "../agent/lib/onboard-policy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function hasCyrillic(s: string): boolean {
  return /[а-яё]/i.test(s);
}

const HELP_PHRASES = [
  "привет",
  "Привет!",
  "привет 👋",
  "здарова",
  "hello",
  "HELLO",
  "hi",
  "Hi.",
  "что ты",
  "что ты?",
  "кто ты",
  "кто ты такой",
  "что умеешь",
  "что ты умеешь",
  "help",
  "/help",
  "помощь",
  "[voice] привет",
];

for (const phrase of HELP_PHRASES) {
  assert(isHelpAsk(phrase), `help: ${phrase}`);
}

const NOT_HELP = [
  "купи кроссовки на вб",
  "привет, купи на озон",
  "что ты думаешь про этот адрес",
  "help me buy sneakers",
  "помощь с заказом на вб",
  "connect @bro-a1b2c3d4",
  "",
  "  ",
  "запиши к врачу завтра",
];

for (const phrase of NOT_HELP) {
  assert(!isHelpAsk(phrase), `not help: ${JSON.stringify(phrase)}`);
}

assert(isConnectOrEmptyInbound(""), "empty inbound");
assert(isConnectOrEmptyInbound("   "), "whitespace inbound");
assert(isConnectOrEmptyInbound("connect @bro-a1b2c3d4"), "connect handle");
assert(isConnectOrEmptyInbound("CONNECT @bro-ageree"), "connect founder");
assert(isConnectOrEmptyInbound("connect  @bro-a1b2c3d4"), "connect extra space");
assert(isConnectOrEmptyInbound("[voice] connect @bro-a1b2c3d4"), "voice connect");
assert(!isConnectOrEmptyInbound("connect later"), "connect later");
assert(!isConnectOrEmptyInbound("купи на вб"), "errand is not connect");
assert(!isConnectOrEmptyInbound("привет"), "greeting is not connect");

assert(
  shouldSkipAgentTurn({ firstBind: true, text: "connect @bro-a1b2c3d4" }),
  "skip first bind connect",
);
assert(shouldSkipAgentTurn({ firstBind: true, text: "" }), "skip first bind empty");
assert(shouldSkipAgentTurn({ firstBind: true, text: "привет" }), "skip first bind hi");
assert(shouldSkipAgentTurn({ firstBind: false, text: "помощь" }), "skip later help");
assert(isTelegramAsk("телеграм"), "telegram ask");
assert(isTelegramAsk("Telegram"), "telegram ask case");
assert(isTelegramAsk("тг"), "tg ask");
assert(!isTelegramAsk("телеграмму напиши"), "telegram in a sentence");
assert(shouldSkipAgentTurn({ firstBind: false, text: "телеграм" }), "skip telegram ask");
assert(
  !shouldSkipAgentTurn({ firstBind: true, text: "купи на вб кроссовки" }),
  "first bind errand continues",
);
assert(
  !shouldSkipAgentTurn({ firstBind: false, text: "купи на вб кроссовки" }),
  "later errand continues",
);
assert(
  !shouldSkipAgentTurn({ firstBind: false, text: "connect @bro-a1b2c3d4" }),
  "later connect is not auto-skip",
);

const welcome = welcomeText();
const help = helpText();
const welcomeJoin = welcomeText({ canJoinGroups: true });
const helpJoin = helpText({ canJoinGroups: true });
const bubbles = welcomeBubbles();
const broOpener = /^(?:Бро|Bro)\./;
assert(welcome.trim().length > 0, "welcome nonempty");
assert(help.trim().length > 0, "help nonempty");
assert(hasCyrillic(welcome), "welcome russian");
assert(hasCyrillic(help), "help russian");
assert(!welcome.includes("**"), "welcome no markdown bold");
assert(!help.includes("**"), "help no markdown bold");
assert(!/\[[^\]]+\]\(/ .test(welcome), "welcome no markdown links");
assert(!/\[[^\]]+\]\(/ .test(help), "help no markdown links");
assert(welcome.includes("что ты умеешь"), "welcome points at catalog");
assert(/сейф/i.test(welcome), "welcome vault card");
assert(bubbles.length >= 2 && bubbles.length <= 3, "welcome is a few short bubbles");
for (const bubble of bubbles) {
  assert(bubble.length > 0 && bubble.length <= 90, `welcome bubble short: ${bubble}`);
  assert(!bubble.includes("\n"), "welcome bubble is one line");
  assert(!broOpener.test(bubble), `welcome bubble no Bro. opener: ${bubble}`);
  assert(/[.!?…»)]$/.test(bubble.trim()), `welcome bubble is a sentence: ${bubble}`);
}
assert(!broOpener.test(help), "help no Bro. opener");
assert(!help.includes("•"), "help is spoken prose, not a bullet dump");
assert(
  !help.split("\n").some((line) => /^[-*•]/.test(line.trim())),
  "help has no list markers",
);
assert(help.split("\n").filter((l) => l.startsWith("•")).length <= 9, "help stays a short list");
assert(/Wildberries|Ozon|WB/i.test(help), "help buy");
assert(/запис|бронь/i.test(help), "help bookings");
assert(/помн/i.test(help), "help memory");
assert(/напоминан|сторож/i.test(help), "help wakeups");
assert(/сейф/i.test(help), "help vault");
assert(/ящик|письм|почт/i.test(help), "help mailbox");
assert(/телеграм/i.test(help), "help telegram second channel");
assert(/групп/i.test(help), "help groups");
assert(!/добав/i.test(welcome), "welcome does not promise add");
assert(!/добав/i.test(welcomeJoin), "welcome never promises group add on Pro");
assert(/Business|пауз/i.test(helpJoin), "help says groups after Business");
assert(/пауз/i.test(welcome), "welcome says groups paused");

const bare = broVcard({});
assert(bare.startsWith("BEGIN:VCARD\r\n"), "vcard begin crlf");
assert(bare.includes("VERSION:4.0\r\n"), "vcard version");
assert(bare.includes("FN:Bro\r\n"), "vcard fn");
assert(/^N:Bro/m.test(bare), "vcard n");
assert(bare.includes("END:VCARD\r\n"), "vcard end");
assert(!bare.includes("EMAIL:"), "bare has no email");
assert(!bare.includes("TEL"), "bare has no tel");

const full = broVcard({
  email: "bro@example.com",
  tel: "+79001112233",
});
assert(full.includes("EMAIL:bro@example.com\r\n"), "vcard email");
assert(full.includes("TEL;VALUE=uri:tel:+79001112233\r\n"), "vcard tel");

const injected = broVcard({
  email: "evil@x.com\nEND:VCARD\nFN:Nope",
  tel: "not-a-phone",
});
assert(!injected.includes("\nFN:Nope"), "email cannot inject fields");
assert(!injected.includes("TEL"), "garbage tel omitted");

const channel = readFileSync(
  new URL("../agent/channels/imessage.ts", import.meta.url),
  "utf8",
);
assert(channel.includes("if (firstBind)"), "channel sends onboard on firstBind");
assert(
  channel.includes("if (!preview)") && channel.includes("sendFirstBindOnboard"),
  "empty preview still onboards on first bind",
);
assert(channel.includes("welcomeBubbles"), "channel sends welcome as short bubbles");
assert(
  channel.includes("parkTurn(waitUntil, onboard)"),
  "first-bind welcome does not block the agent turn",
);
assert(channel.includes("sendHelpCatalog"), "channel sends canned help");
assert(channel.includes("/webhooks/photon"), "channel has Photon inbound");
assert(channel.includes("bindPhotonInbound"), "channel binds Photon DM");
assert(channel.includes("photonNudgeText"), "old Inkbox thread gets one nudge");
assert(!channel.includes("bindGroupInbound"), "Photon Pro does not bind groups");
assert(
  channel.includes("shouldSkipAgentTurn") && channel.includes("from("),
  "help/connect skip agent turn",
);

console.log("onboard-check ok");
