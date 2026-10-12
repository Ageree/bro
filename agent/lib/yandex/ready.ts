import { z } from "zod";
import { goApiPage, goSession } from "./go/session";
import { defineYandexOperation } from "./operations";

const cardSchema = z.object({
  id: z.string(),
  last4: z.string().nullable(),
  title: z.string(),
  verified: z.boolean(),
});

/**
 * Whether the person's Yandex is ready for errands: Bro's browser is signed
 * in (a signed-out browser is `signed_out` before this runs) and which bank
 * cards the account has. Cards are the account's, shared by Eda, Lavka and
 * Go through Trust; Go keeps a card it has not had the bank confirm in
 * `unverified_cards`, and the same check frees it for every service
 * (`docs/dev-notes.md`, «Яндекс Еда»). Only reads: nothing is linked,
 * verified or paid.
 */
export const accountReadyOperation = defineYandexOperation({
  about:
    "Whether the person's Yandex is ready for errands: signed in, and which bank cards are linked and verified for Eda, Lavka and Go. Call it first when the person asks for anything from Yandex for the first time in a conversation, or agrees to try Yandex, and follow its reply before the errand. Takes no arguments.",
  access: "read",
  args: z.object({}),
  id: "account.ready",
  origin: goApiPage,
  result: z.union([
    z.object({ cards: z.array(cardSchema), signedIn: z.literal(true) }),
    z.object({ error: z.string() }),
  ]),
  run: `async function () {${goSession}
  const session = await goSession();
  if (session.wall || session.error) return goAnswer(session);
  const methods = await session.post("/3.0/paymentmethods", { location: [37.6177, 55.7558], id: session.userId });
  if (methods.wall) return { status: "signed_out" };
  if (methods.error) return { status: "ok", data: { error: methods.error } };
  const held = new Set((methods.card?.unverified_cards || []).map((c) => c.id));
  const cards = (methods.card?.available_cards || [])
    .filter((c) => !c.is_hidden && typeof c.id === "string")
    .concat((methods.card?.unverified_cards || []).filter((c) => typeof c.id === "string" &&
      !(methods.card?.available_cards || []).some((a) => a.id === c.id)))
    .map((c) => ({
      id: c.id,
      last4: /[0-9]{4}$/.exec(String(c.number || ""))?.[0] ?? null,
      title: (typeof c.title === "string" && c.title) || [c.system, c.number].filter(Boolean).join(" ") || "карта",
      verified: !held.has(c.id),
    }));
  return { status: "ok", data: { signedIn: true, cards } };
}`,
  service: "yandex",
});

type Readiness = z.output<typeof accountReadyOperation.result>;

/** Told when the browser is not signed in to Yandex yet. */
export const signInFirstReply =
  "Not signed in to Yandex yet. Before the errand, lead the person in one short message: say you will first sign in to their Yandex together, then send a sign-in link (site-login-link with site yandex.ru and signInPage https://passport.yandex.ru/auth); in the window they sign in themselves, you never see the password. The link goes out only for a site the person named in their own words: if they only said «да» to your offer and never named Yandex, ask them to say it, for example «давай войдём в Яндекс». Never ask for the password or a code in the chat. When they say they are in, call account.ready again and go back to the errand.";

/**
 * What the model does next with the readiness it read, in a reply the tool
 * returns beside the data: a weak model keeps the steps of the onboarding
 * from a tool's result, not from the prompt.
 */
export function readinessReply(
  readiness: Readiness,
  options: { readonly canVerify: boolean }
) {
  if (!("cards" in readiness)) {
    return "Yandex did not show the cards just now. Do not guess: go on with the errand, and if a payment fails on the card, call account.ready again.";
  }
  const verified = readiness.cards.find((card) => card.verified);
  if (verified) {
    return `Ready: signed in, and the card ${verified.title} works in Eda, Lavka and Go. If the person only asked to set Yandex up, tell them in one line it is ready and what you can do there now (order food or groceries, call a taxi); otherwise say nothing of this check and go straight on with the errand.`;
  }
  const held = readiness.cards[0];
  if (held === undefined) {
    return "Signed in, but no bank card is linked to Yandex. Say it simply, once: to pay in Eda, Lavka and Go, Yandex needs a card linked once, and it is linked in their own Yandex Go or Yandex Eda app (payment methods, add a card); after that it works in every Yandex service. Never ask for the card number in the chat and never offer to type it yourself. Until then a taxi can be paid in cash; go on with what does not need a card, and call account.ready again when they say the card is added.";
  }
  return options.canVerify
    ? `Signed in, and the card ${held.title} is linked, but the bank has not confirmed it for Yandex yet, so Eda, Lavka and Go may refuse it. Explain in plain words, once: the bank asks to confirm the card one time, like a payment online, and then it works in every Yandex service; nothing is bought. Ask whether to send the bank's link. Only after their yes, call yandex_purchase with action verify_card and cardId ${held.id}; never open the link yourself.`
    : `Signed in, and the card ${held.title} is linked, but the bank has not confirmed it for Yandex yet. Tell the person, once: open the Yandex Go app, payment methods, the card, and confirm it with the bank; after that it works in every Yandex service. Until then a taxi can be paid in cash.`;
}
