import {
  isConnectDest,
  stripConnectUrls,
  wrapConnectUrl,
} from "../agent/lib/connect-link.ts";
import { compileTelegram } from "../agent/lib/telegram-text.ts";
import { toIMessageBubbles, toIMessageText } from "../agent/lib/imessage-text.ts";

import { assert } from "./lib/check.ts";

const good = "https://connect.composio.dev/link/lk_abc";
assert(isConnectDest(good), "allow composio link");
assert(!isConnectDest("https://evil.example/link/lk_abc"), "reject other host");

// `isConnectDest` follows Composio's own extractor: every path on
// connect.composio.dev is a connect link, and the `/link/` marker is only
// demanded of the other composio hosts. Demanding it everywhere silently
// dropped live links shaped like `/c/<id>` — no card, and `/l` answered 400.
assert(isConnectDest("https://connect.composio.dev/c/abc123"), "allow any connect path");
assert(isConnectDest("https://connect.composio.dev/other"), "allow bare connect path");
assert(
  isConnectDest("https://dashboard.composio.dev/link/lk_abc"),
  "dashboard still needs the /link/ marker",
);
assert(
  !isConnectDest("https://dashboard.composio.dev/settings"),
  "dashboard page is not a connect link",
);
assert(!isConnectDest("https://connect.composio.dev/"), "bare host authorizes nothing");
assert(!isConnectDest("http://connect.composio.dev/link/lk_abc"), "https only");

process.env.BRO_PUBLIC_URL = "https://bro-agent.vercel.app";
assert(
  wrapConnectUrl(good) ===
    "https://bro-agent.vercel.app/l?to=" + encodeURIComponent(good),
  "wrap",
);

assert(
  stripConnectUrls("Открой [Gmail](https://connect.composio.dev/link/lk_x) сейчас") ===
    "Открой  сейчас",
  "strip markdown",
);
assert(stripConnectUrls(`Подключи: ${good}`) === "Подключи:", "strip raw url");

// --- the assertion that was missing ---
// Wrap and strip were asserted separately and never composed, so nothing
// noticed that they cancelled each other out: `wrapConnectUrl` built
// `https://bro-agent.vercel.app/l?to=…` and `stripConnectUrls` had a rule
// deleting exactly that. Every Connect Link died on the way out for as long
// as this file only checked each half on its own.
const wrapped = wrapConnectUrl(good);
assert(
  stripConnectUrls(wrapped).includes(wrapped),
  "the sanitiser must not eat our own /l wrapper",
);
assert(
  stripConnectUrls(`открой и подтверди доступ\n${wrapped}`).includes(wrapped),
  "wrapper survives inside a message",
);
// The same, for whatever host `publicOrigin()` resolves to on this deploy —
// BRO_PUBLIC_URL and VERCEL_PROJECT_PRODUCTION_URL both feed it.
process.env.BRO_PUBLIC_URL = "https://bro.example";
const elsewhere = wrapConnectUrl(good);
assert(
  stripConnectUrls(elsewhere).includes(elsewhere),
  "wrapper survives on any public origin",
);
process.env.BRO_PUBLIC_URL = "https://bro-agent.vercel.app";

// The raw destination must still never survive in free text — that is the
// whole point of the sanitiser and the reason the card exists.
assert(
  !stripConnectUrls(`вот ссылка ${good}`).includes("composio.dev"),
  "raw composio url never survives free text",
);

// --- what the human actually receives ---
// `sendConnectIfAny` hands the URL to `deliverHuman` as a button row, so the
// card is asserted the way each channel compiles it, not as a string.
const card = {
  text: "открой и подтверди доступ",
  buttons: [[{ text: "Подключить", url: wrapped }]],
};
const asMarkdown = `${card.text}\n\n:::buttons\n[${card.buttons[0]![0]!.text}](${wrapped})\n:::`;

const compiled = compileTelegram(asMarkdown);
assert(compiled.buttons.length === 1, "telegram card has exactly one button row");
assert(compiled.buttons[0]!.length === 1, "telegram card has exactly one button");
assert(compiled.buttons[0]![0]!.url === wrapped, "telegram button carries the wrapper");
assert(compiled.html.includes("подтверди доступ"), "telegram card keeps its text");

const bubbles = toIMessageBubbles(stripConnectUrls(asMarkdown));
assert(bubbles.length >= 1, "imessage gets at least one bubble");
assert(
  bubbles.join("\n").includes(wrapped),
  "imessage bubble carries the tappable wrapper",
);
assert(
  toIMessageText(stripConnectUrls(asMarkdown)).includes("Подключить"),
  "imessage keeps the button label",
);

console.log("connect-link-check ok");
