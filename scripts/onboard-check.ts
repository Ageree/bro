import {
  broVcard,
  cabinetLoginUrl,
  helpText,
  isConnectOrEmptyInbound,
  isGreeting,
  isHelpAsk,
  isTelegramAsk,
  shouldSendWelcome,
  shouldSkipAgentTurn,
  vaultCardUrl,
  welcomeBubbles,
  welcomeText,
} from "../agent/lib/onboard-policy.ts";

import { assert, src } from "./lib/check.ts";

function hasCyrillic(s: string): boolean {
  return /[а-яё]/i.test(s);
}

const GREETINGS = [
  "привет",
  "Привет!",
  "привет 👋",
  "привет бро",
  "здарова",
  "hello",
  "HELLO",
  "hi",
  "Hi.",
  "[voice] привет",
];

for (const phrase of GREETINGS) {
  assert(isGreeting(phrase), `greeting: ${phrase}`);
  // A bare hello is no longer an ask for the letter — the agent answers it.
  assert(!isHelpAsk(phrase), `greeting is not a help ask: ${phrase}`);
}

const HELP_PHRASES = [
  "что ты",
  "что ты?",
  "кто ты",
  "кто ты такой",
  "что умеешь",
  "что ты умеешь",
  "help",
  "/help",
  "помощь",
];

for (const phrase of HELP_PHRASES) {
  assert(isHelpAsk(phrase), `help: ${phrase}`);
  assert(!isGreeting(phrase), `help ask is not a greeting: ${phrase}`);
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
  assert(!isGreeting(phrase), `not greeting: ${JSON.stringify(phrase)}`);
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
// The whole point: a repeat «привет» is a normal turn, not five canned bubbles.
assert(
  !shouldSkipAgentTurn({ firstBind: false, text: "привет" }),
  "later hi runs the agent turn",
);
assert(
  !shouldSkipAgentTurn({ firstBind: false, text: "hi bro" }),
  "later english hi runs the agent turn",
);
assert(shouldSendWelcome({ firstBind: true, text: "привет" }), "first bind hi gets the letter");
assert(shouldSendWelcome({ firstBind: true, text: "купи на вб кроссовки" }), "first bind always onboards");
assert(!shouldSendWelcome({ firstBind: false, text: "привет" }), "later hi never resends the letter");
assert(!shouldSendWelcome({ firstBind: false, text: "здарова бро" }), "later здарова never resends the letter");
assert(shouldSendWelcome({ firstBind: false, text: "помощь" }), "later помощь resends the letter");
assert(shouldSendWelcome({ firstBind: false, text: "что ты умеешь" }), "later что умеешь resends the letter");
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
  handle: "bro-a1b2c3d4",
  cabinetBase: "https://brobro.tech",
});
const helpJoin = helpText({
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
assert(/^Привет[,!] я Bro[.!]/.test(welcome), "welcome opens as a person saying hi");
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
// Shape contract: a handful of short bubbles, and the two link bubbles last.
assert(bubbles.length >= 4 && bubbles.length <= 8, "welcome is a few short bubbles then vault and cabinet");
assert(/^Привет[,!] я Bro[.!]/.test(bubbles[0]!), "first bubble is a plain hello from Bro");
assert(bubbles[0]!.length <= 120, "the hello is a one-liner, not a pitch");
for (const bubble of bubbles) {
  assert(bubble.length > 0 && bubble.length <= 700, `welcome bubble sized: ${bubble.slice(0, 40)}`);
  assert(!broOpener.test(bubble), `welcome bubble no Bro. opener: ${bubble}`);
  // The owner's complaint was a 600-char capability wall. A person texts in
  // short bubbles; the URL itself does not count against the prose budget.
  const prose = bubble.split("\n").filter((line) => !line.startsWith("http")).join(" ");
  assert(prose.length <= 300, `welcome bubble is a text, not a paragraph: ${prose.slice(0, 60)}`);
}
// The two links: last two bubbles, each URL alone on its own line, and no
// link anywhere before them.
const vaultBubble = bubbles[bubbles.length - 2]!;
const cabinetBubble = bubbles[bubbles.length - 1]!;
for (const bubble of bubbles.slice(0, -2)) {
  assert(!bubble.includes("http"), `only the last two bubbles carry links: ${bubble.slice(0, 40)}`);
}
assert(/\nhttps:\/\/\S+$/.test(vaultBubble), "vault URL sits alone on the last line of its bubble");
assert(vaultBubble.includes("vault.html?kind=payment"), "vault bubble is the payment card link");
assert(/карт/i.test(vaultBubble) && /не пиши/i.test(vaultBubble), "vault bubble: card number never in chat");
assert(/телефон/i.test(vaultBubble) && /код/i.test(vaultBubble), "vault bubble keeps the phone+code instruction");
assert(/\nhttps:\/\/\S+$/.test(cabinetBubble), "cabinet URL sits alone on the last line of its bubble");
assert(cabinetBubble.includes("/cabinet.html"), "cabinet bubble is the cabinet link");
assert(/телефон/i.test(cabinetBubble) && /код/i.test(cabinetBubble), "cabinet bubble keeps its short instruction");
// The login promise, wherever it is phrased: vault or a link, and the
// password never travels through the chat.
const loginBubble = bubbles.find(
  (b) => !b.includes("http") && /сейф/i.test(b) && /ссылк/i.test(b),
);
assert(loginBubble, "welcome says a site login comes from the vault or a link");
assert(/парол\S*[^.!?]*не пиши/i.test(loginBubble!), "welcome states the password never goes in chat");
assert(/ящик|почт|письм/i.test(loginBubble!), "welcome says mail and codes land on Bro's own mailbox");
assert(!broOpener.test(help), "help no Bro. opener");
assert(!help.includes("•"), "help is spoken prose, not a bullet dump");
assert(
  !help.split("\n").some((line) => /^[-*•]/.test(line.trim())),
  "help has no list markers",
);
assert(/Wildberries|Ozon|WB/i.test(help), "help buy");
assert(/запиш|запис|брон/i.test(help), "help bookings");
assert(/помн/i.test(help), "help memory");
assert(/напомн|напоминан|сторож/i.test(help), "help wakeups");
assert(/сейф/i.test(help), "help vault");
assert(/ящик|письм|почт/i.test(help), "help mailbox");
assert(/телеграм/i.test(help), "help telegram second channel");
assert(!/добав/i.test(welcome), "welcome does not promise add");
// Groups are gone from the product and from the letter: the letter must not
// raise a capability the person cannot use and Bro cannot deliver.
assert(!/групп/i.test(help), "the letter must not mention groups at all");
assert(!/групп/i.test(welcome), "the letter must not mention groups at all");
assert(/код/i.test(welcome), "welcome explains the iMessage login code");
assert(!welcome.includes("скажи пароль"), "welcome never asks for a site password");
assert(/цен/i.test(welcome), "welcome keeps the price watch");
assert(/стол/i.test(welcome), "welcome keeps the table booking");

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
assert(
  channel.includes("shouldSendWelcome({ firstBind, text: inbound.text })"),
  "one rule decides the letter: first bind, or an explicit help ask later",
);
assert(
  !channel.includes("isHelpAsk"),
  "the channel no longer resends the letter on its own help check",
);
assert(channel.includes("/webhooks/photon"), "channel has Photon inbound");
assert(channel.includes("bindPhotonInbound"), "channel binds Photon DM");
assert(channel.includes("photonNudgeText"), "old Inkbox thread gets one nudge");
assert(
  channel.includes("shouldSkipAgentTurn") && channel.includes("from("),
  "help/connect skip agent turn",
);

console.log("onboard-check ok");
