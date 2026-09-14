import {
  broVcard,
  cabinetLoginUrl,
  helpText,
  isConnectOrEmptyInbound,
  isHelpAsk,
  isTelegramAsk,
  shouldSkipAgentTurn,
  vaultCardUrl,
  welcomeBubbles,
  welcomeText,
} from "../agent/lib/onboard-policy.ts";

import { assert, src } from "./lib/check.ts";

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

const welcome = welcomeText({
  handle: "bro-a1b2c3d4",
  cabinetBase: "https://brobro.tech",
});
const help = helpText({
  handle: "bro-a1b2c3d4",
  cabinetBase: "https://brobro.tech",
});
const welcomeJoin = welcomeText({
  canJoinGroups: true,
  handle: "bro-a1b2c3d4",
  cabinetBase: "https://brobro.tech",
});
const helpJoin = helpText({
  canJoinGroups: true,
  handle: "bro-a1b2c3d4",
  cabinetBase: "https://brobro.tech",
});
const bubbles = welcomeBubbles({
  handle: "bro-a1b2c3d4",
  cabinetBase: "https://brobro.tech",
});
const broOpener = /^(?:Бро|Bro)\./;
assert(welcome.trim().length > 0, "welcome nonempty");
assert(help.trim().length > 0, "help nonempty");
assert(welcome === help, "welcome and help are the same letter");
assert(hasCyrillic(welcome), "welcome russian");
assert(hasCyrillic(help), "help russian");
assert(!welcome.includes("**"), "welcome no markdown bold");
assert(!help.includes("**"), "help no markdown bold");
assert(!/\[[^\]]+\]\(/ .test(welcome), "welcome no markdown links");
assert(!/\[[^\]]+\]\(/ .test(help), "help no markdown links");
assert(welcome.startsWith("Привет, я Bro."), "welcome opens as a person");
assert(/сейф/i.test(welcome), "welcome vault card");
assert(welcome.includes("vault.html?kind=payment"), "welcome sends the real vault card URL");
assert(!welcome.includes("handle="), "welcome vault/cabinet URLs have no handle");
assert(!welcome.includes("bro-a1b2c3d4"), "welcome never shows the handle");
assert(welcome.includes("/cabinet.html"), "welcome sends cabinet login URL");
assert(!/bro-[a-z0-9]{8}/.test(welcome), "welcome copy has no bro-xxxxxxxx");
assert(
  vaultCardUrl("https://brobro.tech").includes("kind=payment") &&
    !vaultCardUrl("https://brobro.tech").includes("handle="),
  "new vault URL is payment setup without handle",
);
assert(
  vaultCardUrl("https://brobro.tech", "bro-a1b2c3d4").includes("handle=bro-a1b2c3d4"),
  "old vault URL can still carry handle as a fallback",
);
assert(
  cabinetLoginUrl("https://brobro.tech") === "https://brobro.tech/cabinet.html",
  "new cabinet URL has no handle",
);
assert(
  cabinetLoginUrl("https://brobro.tech", "bro-a1b2c3d4").includes("handle=bro-a1b2c3d4"),
  "old cabinet URL can still carry handle as a fallback",
);
assert(/телефон/i.test(welcome), "welcome login is the phone");
assert(bubbles.length >= 4 && bubbles.length <= 6, "welcome is a letter then vault and cabinet");
assert(bubbles[0] === "Привет, я Bro. Я твой личный ассистент.", "first bubble is the greeting");
for (const bubble of bubbles) {
  assert(bubble.length > 0 && bubble.length <= 700, `welcome bubble sized: ${bubble.slice(0, 40)}`);
  assert(!broOpener.test(bubble), `welcome bubble no Bro. opener: ${bubble}`);
}
assert(!broOpener.test(help), "help no Bro. opener");
assert(!help.includes("•"), "help is spoken prose, not a bullet dump");
assert(
  !help.split("\n").some((line) => /^[-*•]/.test(line.trim())),
  "help has no list markers",
);
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
assert(/код/i.test(welcome), "welcome explains the iMessage login code");
assert(!welcome.includes("скажи пароль"), "welcome never asks for a site password");
assert(/сейфа или пришлю ссылку/i.test(welcome), "welcome: vault login or live-view link");

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

const channel = src("agent/channels/imessage.ts");
assert(channel.includes("if (firstBind)"), "channel sends onboard on firstBind");
assert(
  channel.includes("if (!preview)") && channel.includes("sendWelcomeLetter"),
  "empty preview still onboards on first bind",
);
assert(channel.includes("welcomeBubbles"), "channel sends welcome as short bubbles");
assert(channel.includes("attachCabinetLogin"), "channel mints a cabinet handle if missing");
assert(
  channel.includes("parkTurn(waitUntil, onboard)"),
  "first-bind welcome does not block the agent turn",
);
assert(channel.includes("!firstBind && isHelpAsk"), "later help resends the same letter");
assert(channel.includes("/webhooks/photon"), "channel has Photon inbound");
assert(channel.includes("bindPhotonInbound"), "channel binds Photon DM");
assert(channel.includes("photonNudgeText"), "old Inkbox thread gets one nudge");
assert(!channel.includes("bindGroupInbound"), "Photon Pro does not bind groups");
assert(
  channel.includes("shouldSkipAgentTurn") && channel.includes("from("),
  "help/connect skip agent turn",
);

console.log("onboard-check ok");
