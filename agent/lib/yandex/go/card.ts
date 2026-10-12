import { z } from "zod";
import { defineYandexOperation } from "../operations";
import { goApiPage, goSession } from "./session";

/**
 * A bank check of one linked card that Go keeps unverified
 * (`card_antifraud`), the way Trust's web SDK starts one: a verification
 * intent for the card, whose form the person opens. Verification is shared
 * by Yandex's services, so the card works in Go and the others afterwards.
 * Only the person opens the form: opening it elsewhere spends the bank's
 * session.
 */
export const goCardVerifyOperation = defineYandexOperation({
  about:
    "A bank (3-D Secure) link that verifies one linked card Yandex Go keeps unverified; only the person opens it.",
  access: "purchase",
  args: z.object({
    cardId: z.string().regex(/^card-x[0-9a-f]{1,64}$/u),
    near: z
      .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
      .default([37.6177, 55.7558]),
  }),
  id: "go.card_verify",
  origin: goApiPage,
  result: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("link"),
      card: z.string(),
      last4: z.string().nullable(),
      url: z.string(),
    }),
    z.object({ kind: z.literal("verified") }),
    z.object({ kind: z.literal("failed"), reason: z.string() }),
  ]),
  run: `async function (args) {${goSession}
  const session = await goSession();
  if (session.wall || session.error) return goAnswer(session);
  const ok = (data) => ({ status: "ok", data });
  const methods = await session.post("/3.0/paymentmethods", { location: args.near, id: session.userId });
  if (methods.wall) return { status: "signed_out" };
  const card = (methods.card?.unverified_cards || []).find((c) => c.id === args.cardId);
  if (!card) {
    const usable = (methods.card?.available_cards || []).some((c) => c.id === args.cardId);
    return ok(usable ? { kind: "verified" } : { kind: "failed", reason: "card_not_found" });
  }
  // Go's Trust service token, as its page config gives it to every visitor.
  const page = await fetch("/", { credentials: "include", signal: AbortSignal.timeout(15000) });
  const token = /"trustToken":"([A-Za-z0-9_]{1,100})"/.exec(await page.text())?.[1];
  if (!token) return ok({ kind: "failed", reason: "no_trust_token" });
  const response = await fetch("https://trust.yandex.ru/web/create_verification_intent?service_token=" + encodeURIComponent(token), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      currency: typeof card.currency === "string" ? card.currency : "RUB",
      binding_id: card.id,
      form_params: {
        integrationProfileId: card.profile?.name || methods.card?.profile?.name || "yandex_default",
        mode: "default", flow: "card", type: "verification",
        query_params: { theme: "light", lang: "ru", layout: "default" },
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const intent = await response.json().catch(() => null);
  const url = typeof intent?.form_url === "string" ? intent.form_url : "";
  // Only Trust's own form: a link elsewhere is not sent to the person.
  if ((response.status !== 201 && response.status !== 200) || !url.startsWith("https://trust.yandex.ru/web/binding?")) {
    return ok({ kind: "failed", reason: "trust_" + response.status });
  }
  const title = typeof card.title === "string" && card.title ? card.title : [card.system, card.number].filter(Boolean).join(" ");
  const last4 = /[0-9]{4}$/.exec(String(card.number || ""))?.[0] ?? null;
  return ok({ kind: "link", card: title || "карта", last4, url });
}`,
  service: "go",
});
