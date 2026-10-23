import type { ToolContext } from "eve/tools";
import { makeLoginHandoff } from "@agent/lib/login-handoff/make";
import { loginHandoffPilot } from "@agent/lib/login-handoff/pilot";
import { handoffSite } from "@agent/lib/login-handoff/site";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { statusOperation } from "./status";
import { type YandexOutcome, runYandexOperation } from "./transport";

/** Yandex ID's own sign-in form, where the window opens. */
const signInPage = "https://passport.yandex.ru/auth";

const linkReply =
  "Not signed in to Yandex yet, so nothing was done. Lead the person in one short message: to do this through Yandex (and later taxis, food and groceries in seconds) you will first sign in to their Yandex together, once. Send link as it is, on a line of its own: it opens a window of Bro's own browser on Yandex, where they sign in themselves (login, password and any code right there; tick «Запомнить меня» if offered), then press «Готово»; Bro does not keep the password and stays signed in there for later errands. The link works for 30 minutes from one device, so they must not forward it. Never ask for the password or a code in the chat, never offer to take them, and do not do the errand with browser_task instead. Once they are in, go back to their errand.";

const busyReply =
  "Nothing was done: Bro's browser is not signed in to Yandex, and a sign-in window of this person is open right now. Tell them to finish signing in there and press «Готово», or close it, then go back to their errand. Do not do it with browser_task instead.";

const noLinkReply =
  "Bro's browser is not signed in to Yandex, and no sign-in link can be made here. Tell the person so; the errand can go through browser_task, which signs in itself and asks for any code in the chat. Never ask for the password in the chat.";

// Yandex ID says the browser is signed in: a link would change nothing.
const serviceRefusedReply =
  "Nothing was done: the browser is signed in to Yandex, but this service did not take the sign-in just now. Try once more; if it fails again, tell the person it cannot be done from here right now (a taxi can be ordered in the Yandex Go app). Do not send a sign-in link and never ask for a password.";

interface SignIn {
  readonly link?: string;
  readonly reply: string;
}

/**
 * The sign-in of one turn, so calls of a step that all come back signed out
 * share one link: a second link cancels the first (`createLoginHandoff`),
 * and the one the message carries could be the cancelled one.
 */
const turnSignIns = new Map<string, { at: number; done: Promise<SignIn> }>();
const turnSignInMs = 10 * 60_000;

/**
 * The sign-in a Yandex call needs when Bro's browser is not signed in to
 * Yandex: a link where the person signs in themselves, made here and handed
 * to the model with what to say. 23.10 a new person asked for a taxi, every
 * Go call failed, and Bro booked on the site, which stopped at Yandex ID and
 * offered to take the password in the chat. The site is Yandex because these
 * tools are Yandex's, not because a page or the model named it, so the link
 * does not wait for the person to say «Яндекс» (`site-login-link` does).
 * A service's own refusal is checked with Yandex ID first. Only the tools of
 * a turn the person's own message opened call this.
 */
export async function yandexSignIn(
  context: ToolContext,
  outcome: Extract<YandexOutcome, { kind: "signed_out" }>
): Promise<SignIn> {
  const { id, turn } = context.session;
  const key = `${id}:${turn.id}:${String(turn.sequence)}`;
  const now = Date.now();
  for (const [stale, given] of turnSignIns)
    if (now - given.at > turnSignInMs) turnSignIns.delete(stale);
  const given = turnSignIns.get(key);
  if (given) return given.done;
  const done = signIn(context, outcome);
  turnSignIns.set(key, { at: now, done });
  return done;
}

async function signIn(
  context: ToolContext,
  outcome: Extract<YandexOutcome, { kind: "signed_out" }>
): Promise<SignIn> {
  const caller = context.session.auth.current;
  const site = handoffSite(signInPage);
  if (caller?.principalType !== "user" || site.kind !== "ok") {
    return { reply: noLinkReply };
  }
  const scope = scopeFromPrincipal(caller);
  if (outcome.byYandexId !== true) {
    const said = await runYandexOperation(
      scope.workspaceId,
      statusOperation,
      {}
    );
    if (said.kind === "ok") return { reply: serviceRefusedReply };
  }
  if (!(await loginHandoffPilot(scope))) return { reply: noLinkReply };
  const made = await makeLoginHandoff(
    context,
    { allowedDomains: site.allowedDomains, domain: site.domain },
    site.url
  );
  if (made.kind === "made") return { link: made.link, reply: linkReply };
  return { reply: made.kind === "busy" ? busyReply : noLinkReply };
}
