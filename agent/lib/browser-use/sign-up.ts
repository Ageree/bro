import { randomInt } from "node:crypto";
import { ensureAgentMailbox } from "@agent/lib/agent-mail/client";
import {
  deleteVaultItem,
  readVaultItems,
  readVaultSecret,
  saveVaultItem,
} from "@db/services/vault";
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

/** What the run is told about registering, for the errand that does. */
export function signUpLine(username: string) {
  return [
    `${agentMailSignUpSentence} the email address is the secret ${browserSecretAliases.loginUsername} and the password the secret ${browserSecretAliases.loginPassword} — focus the field and ask for the secret by name; the server types it, and you never see it. Type ${browserSecretAliases.loginPassword} into the password field and into its confirmation field too.`,
    `Where the form insists on a user name or a nickname, use ${username}; where it insists on a name, use «Bro». Never type the person's name, phone, own email, address, birth date or anything else of theirs, and never pay or subscribe to anything paid. Accept the terms the sign-up needs, and leave newsletters and marketing unticked.`,
    `If the site sends a code or a link to that email to confirm it, finish the form and stop with NEEDS: email_code, saying in DETAILS whether the letter carries a code or a link: Bro takes it from its own mailbox. If the site says the address is already registered, sign in with the same two secrets instead. Never write a password or a secret's value in your report.`,
  ].join(" ");
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
 * vault already has a login for the site, which the run signs in with
 * rather than registering anew; otherwise the address to register with.
 * Undefined when the workspace has no agent mailbox or the site cannot
 * hold a login.
 */
export async function agentMailSignUp(scope: AccessScope, site: string) {
  const origin = loginOrigin(site);
  if (origin === undefined) return undefined;
  const mailbox = await ensureAgentMailbox(scope);
  if (!mailbox) return undefined;
  if ((await savedLoginId(scope, site)) !== undefined) {
    return { kind: "saved" as const };
  }
  return {
    email: mailbox.email,
    kind: "new" as const,
    origin,
    username: signUpUsername(mailbox.email),
  };
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
    label: `Аккаунт Бро на ${new URL(account.origin).hostname}`,
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
  if (site === null || site === undefined) return undefined;
  try {
    const mailbox = await ensureAgentMailbox(scope);
    if (!mailbox) return undefined;
    const loginId = await savedLoginId(scope, site);
    const secret =
      loginId === undefined ? undefined : await readVaultSecret(scope, loginId);
    const payload =
      secret === undefined ? undefined : parseLoginVaultPayload(secret);
    return payload?.identifier.type === "email" &&
      payload.identifier.value.toLowerCase() === mailbox.email.toLowerCase()
      ? mailbox
      : undefined;
  } catch (error) {
    console.warn("[browser-use] the agent mailbox could not be matched", {
      cause: error,
    });
    return undefined;
  }
}
