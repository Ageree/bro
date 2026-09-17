import {
  isConnectDest,
  stripConnectUrls,
  publicOrigin,
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

delete process.env.BRO_LINK_ORIGIN;
delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
delete process.env.VERCEL_URL;
process.env.BRO_PUBLIC_URL = "https://bro-agent.vercel.app";
assert(
  wrapConnectUrl(good) ===
    "https://bro-agent.vercel.app/l?to=" + encodeURIComponent(good),
  "wrap",
);

// --- the second assertion that was missing ---
// The wrapper must point at the host that actually serves `GET /l`, i.e. this
// agent's own deployment. It used to read BRO_PUBLIC_URL first, and in
// production that is the BRAND domain (brobro.tech) — a different Vercel
// project, the landing site, with no such route. Every Connect Link was
// delivered, well-formed and validated, and answered 404 NOT_FOUND. Reported,
// reasonably, as "composio is broken".
{
  process.env.BRO_PUBLIC_URL = "https://brobro.tech";
  process.env.VERCEL_PROJECT_PRODUCTION_URL = "bro-agent.vercel.app";
  assert(
    publicOrigin() === "https://bro-agent.vercel.app",
    "the brand domain never decides where /l is: the agent's own origin does",
  );
  assert(
    !wrapConnectUrl(good).includes("brobro.tech"),
    "and no wrapped link can point at a project that does not serve the route",
  );
  process.env.BRO_LINK_ORIGIN = "https://links.example";
  assert(
    publicOrigin() === "https://links.example",
    "BRO_LINK_ORIGIN is the explicit override for a domain that does proxy /l",
  );
  assert(
    publicOrigin() === "https://links.example" &&
      wrapConnectUrl(good).startsWith("https://links.example/l?to="),
    "and the override reaches the wrapper",
  );
  delete process.env.BRO_LINK_ORIGIN;
  process.env.VERCEL_PROJECT_PRODUCTION_URL = "https://bro-agent.vercel.app/";
  assert(
    publicOrigin() === "https://bro-agent.vercel.app",
    "a scheme-carrying, slash-trailing origin is normalised, not doubled",
  );
  delete process.env.BRO_PUBLIC_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
}
process.env.VERCEL_PROJECT_PRODUCTION_URL = "bro-agent.vercel.app";

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
// The same, for whatever host `publicOrigin()` resolves to on this deploy.
process.env.BRO_LINK_ORIGIN = "https://bro.example";
const elsewhere = wrapConnectUrl(good);
assert(
  stripConnectUrls(elsewhere).includes(elsewhere),
  "wrapper survives on any link origin",
);
delete process.env.BRO_LINK_ORIGIN;

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
