import { randomInt } from "node:crypto";
import { ensureAgentMailbox } from "@agent/lib/agent-mail/client";
import {
  deleteVaultItem,
  readVaultItems,
  readVaultSecret,
  saveVaultItem,
} from "@db/services/vault";
import { applicationOrigin } from "@shared/environment/origin";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  parseLoginVaultPayload,
  serializeLoginVaultPayload,
} from "@shared/vault/schema";
import { siteUrl } from "./host";
import { browserSecretAliases, selectBrowserVaultItems } from "./secrets";

/**
 * An account Bro registers on a site with its own AgentMail address, when
 * the person asked for one (owner, 05.10). It carries none of their
 * details: the address is the workspace agent's, the password is made here
 * and saved in the vault as the site's login, so the run types both by
 * alias and never sees them, nothing of it reaches the chat, and the next
 * errand on the site signs in with it by itself. The letter that confirms
 * the address comes to that mailbox, and the tool takes the code or the
 * link from it (`mail-code.ts`).
 */

/**
 * The sentence, word for word, that tells a run it registers the account.
 * A follow-up, a queued start and a background retry know their errand is
 * a sign-up by it, as `phoneSignInSentence` tells them of a phone sign-in.
 */
export const agentMailSignUpSentence =
  "This errand registers a new account on the errand's site with Bro's own mailbox, not the person's:";

/** Whether a composed run was told to register with Bro's own mailbox. */
export function registersWithAgentMail(task: string | undefined) {
  return task?.includes(agentMailSignUpSentence) === true;
}

const lowerLetters = "abcdefghjkmnpqrstuvwxyz";
const upperLetters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const digitCharacters = "23456789";

function pick(characters: string) {
  return characters.charAt(randomInt(characters.length));
}

/**
 * A password most sign-up forms take as it is: 18 characters with a lower
 * and an upper case letter, a digit and «!», none that reads as another.
 */
export function generatedPassword() {
  const any = `${lowerLetters}${upperLetters}${digitCharacters}`;
  const characters = [
    pick(lowerLetters),
    pick(upperLetters),
    pick(digitCharacters),
    "!",
    ...Array.from({ length: 14 }, () => pick(any)),
  ];
  // Fisher–Yates, so the classes do not sit at fixed places.
  for (let index = characters.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    const here = characters[index] ?? "";
    characters[index] = characters[other] ?? "";
    characters[other] = here;
  }
  return characters.join("");
}

/**
 * The user name a form that asks for one gets: the mailbox's own name,
 * letters and digits only, so the account reads as the agent's and the
 * same one comes back on every errand.
 */
export function signUpUsername(email: string) {
  const local = (email.split("@")[0] ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "");
  const name =
    /^[a-z]/u.test(local) && local.length >= 4 ? local : `bro${local}`;
  return name.slice(0, 20);
}

/**
 * What the start's run says in its footer when it never sent the sign-up
 * form: only the start is asked, so only the start's word can take the
 * prepared login out of the vault (`signUpSettlement`).
 */
const unsubmittedFooterLine =
  "or ACCOUNT: none when you never submitted the sign-up form.";

/**
 * What the run is told about registering, for the errand that does. `start`:
 * the errand's own first run, the only one that may say no form was sent.
 */
export function signUpLine(username: string, start = false) {
  return [
    `${agentMailSignUpSentence} the email address is the secret ${browserSecretAliases.loginUsername} and the password the secret ${browserSecretAliases.loginPassword} — focus the field and ask for the secret by name; the server types it, and you never see it. Type ${browserSecretAliases.loginPassword} into the password field and into its confirmation field too.`,
    `Where the form insists on a user name or a nickname, use ${username}; where it insists on a name, use «Bro». Never type the person's name, phone, own email, address, birth date or anything else of theirs, and never pay or subscribe to anything paid. Accept the terms the sign-up needs, and leave newsletters and marketing unticked.`,
    `If the site sends a code or a link to that email to confirm it, finish the form and stop with NEEDS: email_code, saying in DETAILS whether the letter carries a code or a link: Bro takes it from its own mailbox. If the site says the address is already registered, sign in with the same two secrets instead. Never write a password or a secret's value in your report.`,
    `Add one more line to the labelled footer: ACCOUNT: created once the site accepted the sign-up — even while it still waits for the email to be confirmed${start ? `, ${unsubmittedFooterLine}` : "."}`,
  ].join(" ");
}

/**
 * What a sign-up run said of the account in its footer: `created` once the
 * site took the form, `none` when it never sent it, or nothing it said.
 */
export function signUpAccount(result: string | null | undefined) {
  const value =
    /^[ \t]*(?:[-*•]+[ \t]*)?\**ACCOUNT\**[ \t]*:[ \t]*\**[ \t]*([a-z]+)/imu
      .exec(result ?? "")?.[1]
      ?.toLowerCase();
  return value === "created" || value === "none" ? value : undefined;
}

/**
 * What a settled sign-up run means for the login saved for it before it
 * started, once the errand no longer waits on a step (a code, a link, an
 * answer): `created` — the account exists, and the person hears where its
 * login is; `forget` — the errand's own first run says it never sent the
 * form (or the site's name does not exist), so no account can have it and
 * the prepared login is taken out; `kept` — anything else, from a refusal
 * to a failed run: the site may have taken the form, and a login thrown
 * away then would leave an account nobody can sign in to, so it stays and
 * the person hears so. A later attempt after an anti-bot wall is never
 * sure: an earlier one may have sent the form.
 */
export function signUpSettlement(
  run: { readonly result?: string | null; readonly task: string },
  options: {
    readonly firstAttempt: boolean;
    readonly missingSite: boolean;
    readonly waitsOnStep: boolean;
  }
) {
  if (!registersWithAgentMail(run.task) || options.waitsOnStep) {
    return undefined;
  }
  const account = signUpAccount(run.result);
  if (account === "created") return "created" as const;
  const startRun = run.task.includes(unsubmittedFooterLine);
  return startRun &&
    options.firstAttempt &&
    (account === "none" || options.missingSite)
    ? ("forget" as const)
    : ("kept" as const);
}

/** The vault label of the account Bro registered on `host`. */
function signUpLoginLabel(host: string) {
  return `Аккаунт Бро на ${host}`;
}

/** Where the person finds the login in the cabinet, as its pages name it. */
function vaultLoginsPlace() {
  const place = "раздел «Сейф» → «Входы»";
  try {
    return `${place} (${new URL("/vault", applicationOrigin()).toString()})`;
  } catch {
    return place;
  }
}

/**
 * Settles the login saved for a sign-up run as `signUpSettlement` decided,
 * and the line the report turn gets about it. It never fails the report: a
 * vault that cannot be read leaves the login as it is.
 */
export async function settleSignUpLogin(
  scope: AccessScope,
  site: string | null,
  settlement: "created" | "forget" | "kept"
) {
  const host = site === null ? undefined : siteUrl(site)?.hostname;
  if (host === undefined || host === "") return undefined;
  const label = signUpLoginLabel(host);
  const login = await siteAgentLogin(scope, site);
  if (login === undefined) return undefined;
  if (settlement === "forget") {
    await forgetAgentMailLogin(scope, login.loginId);
    return `The sign-up form on ${host} was never sent, so the login prepared for it was taken out of the user's vault; a new sign-up there starts afresh. Never write a password.`;
  }
  if (settlement === "created") {
    return `The run registered a new account on ${host} with your own AgentMail address ${login.mailbox.email}, and its login is already in the user's vault, so they add nothing by hand. Say in one short sentence that the account is saved in the vault, ${vaultLoginsPlace()}, as «${label}», where they can see its login and password with «Показать данные для входа», and that you sign in there yourself. Never write the password: the vault shows it to them.`;
  }
  return `The run did not confirm that the account on ${host} was created. The login prepared for it stays in the user's vault, ${vaultLoginsPlace()}, as «${label}», in case the site did take the form: say so in one short line along with what stopped the registration. Never write the password.`;
}

/** The origin a login for the site is saved under, or none for a bad site. */
function loginOrigin(site: string) {
  const url = siteUrl(site);
  return url?.protocol === "https:" && url.hostname !== ""
    ? url.origin
    : undefined;
}

/** The vault's login for the site, as the run would be bound to it. */
async function savedLoginId(scope: AccessScope, site: string) {
  return selectBrowserVaultItems(await readVaultItems(scope), {
    allowPayment: false,
    site,
  }).loginId;
}

/**
 * How a start that registers with Bro's own mailbox goes: `saved` when the
 * vault already has the person's login for the site, which the run signs
 * in with rather than registering anew; `again` when the saved login is
 * Bro's own from an earlier sign-up, whose account may never have been
 * made (05.10: reCAPTCHA stopped the first one, and the second only signed
 * in to nothing) — the run registers with that same login, or signs in
 * where the site already has the address; otherwise the address to
 * register with, under a new login. Undefined when the workspace has no
 * agent mailbox or the site cannot hold a login.
 */
export async function agentMailSignUp(scope: AccessScope, site: string) {
  const origin = loginOrigin(site);
  if (origin === undefined) return undefined;
  const mailbox = await ensureAgentMailbox(scope);
  if (!mailbox) return undefined;
  const account = {
    email: mailbox.email,
    origin,
    username: signUpUsername(mailbox.email),
  };
  if ((await savedLoginId(scope, site)) !== undefined) {
    return (await siteAgentLogin(scope, site)) === undefined
      ? { kind: "saved" as const }
      : { ...account, kind: "again" as const };
  }
  return { ...account, kind: "new" as const };
}

/**
 * Saves the account the run is about to register as the site's login in
 * the vault — Bro's address and a fresh password — before the run starts,
 * so the run, a queued start, a background retry and every later errand on
 * the site are bound to the same one. The vault item's id comes back, to
 * take it out again when the run never started.
 */
export function saveAgentMailLogin(
  scope: AccessScope,
  account: { readonly email: string; readonly origin: string }
) {
  return saveVaultItem(scope, {
    account: "",
    kind: "login",
    label: signUpLoginLabel(new URL(account.origin).hostname),
    secret: serializeLoginVaultPayload({
      authentication: { password: generatedPassword(), type: "password" },
      identifier: { type: "email", value: account.email },
      kind: "login",
      origin: account.origin,
      version: 2,
    }),
  });
}

/** Takes a saved sign-up login out again: its run never started. */
export async function forgetAgentMailLogin(scope: AccessScope, id: string) {
  try {
    await deleteVaultItem(scope, id);
  } catch (error) {
    console.warn("[browser-use] the unused sign-up login stays in the vault", {
      cause: error,
    });
  }
}

/**
 * Bro's own mailbox when the site's saved login is its address: the site
 * writes there, so a code or a link it emails is looked for in that inbox
 * rather than in the person's Gmail. Undefined otherwise, and when the
 * mailbox cannot be read — the person's Gmail is looked in then.
 */
export async function siteAgentMailbox(
  scope: AccessScope,
  site: string | null | undefined
) {
  return (await siteAgentLogin(scope, site))?.mailbox;
}

/**
 * The site's saved login and Bro's own mailbox, when that login is the
 * mailbox's address; undefined otherwise or when either cannot be read.
 */
async function siteAgentLogin(
  scope: AccessScope,
  site: string | null | undefined
) {
  if (site === null || site === undefined) return undefined;
  try {
    const mailbox = await ensureAgentMailbox(scope);
    if (!mailbox) return undefined;
    const loginId = await savedLoginId(scope, site);
    if (loginId === undefined) return undefined;
    const secret = await readVaultSecret(scope, loginId);
    const payload =
      secret === undefined ? undefined : parseLoginVaultPayload(secret);
    return payload?.identifier.type === "email" &&
      payload.identifier.value.toLowerCase() === mailbox.email.toLowerCase()
      ? { loginId, mailbox }
      : undefined;
  } catch (error) {
    console.warn("[browser-use] the agent mailbox could not be matched", {
      cause: error,
    });
    return undefined;
  }
}
