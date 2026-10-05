import type { AccessScope } from "@shared/identity/access-scope";
import { parseLoginVaultPayload } from "@shared/vault/schema";
import { readAgentMailbox } from "@db/services/agent-mailboxes";
import { listVaultItems, readVaultSecret } from "@db/services/vault";

/**
 * The logins Bro registered on sites with its own AgentMail mailbox
 * (`agent/lib/browser-use/sign-up.ts`). They are the only vault items the
 * person can read back in the cabinet (owner, 05.10): Bro made the password
 * up, so without it they could never sign in to that account themselves.
 * Their own passwords and cards stay write-only. What makes a login Bro's
 * is decided here from the decrypted login — its identifier is an email
 * equal to the workspace's current mailbox address — never from its label.
 */

/**
 * The masked account a login with `email` is listed under
 * (`loginAccountHint`): only those are decrypted to be checked.
 */
function maskedAddress(email: string) {
  const [localPart = "", domain = ""] = email.split("@", 2);
  return `${localPart.slice(0, 1)}•••@${domain}`;
}

/** The workspace's mailbox address, lower case, when it has one. */
async function mailboxAddress(scope: AccessScope) {
  const mailbox = await readAgentMailbox(scope);
  return mailbox?.email.toLowerCase();
}

/** The login item's email and password when it is Bro's own account. */
async function broLogin(scope: AccessScope, id: string, address: string) {
  const secret = await readVaultSecret(scope, id);
  const payload =
    secret === undefined ? undefined : parseLoginVaultPayload(secret);
  if (
    payload?.identifier.type !== "email" ||
    payload.identifier.value.toLowerCase() !== address ||
    payload.authentication.type !== "password"
  ) {
    return undefined;
  }
  return {
    email: payload.identifier.value,
    password: payload.authentication.password,
  };
}

/**
 * The vault ids of Bro's own logins in this workspace: what the cabinet
 * offers to show, worked out on the server, with no secret leaving it.
 */
export async function listBroLoginIds(scope: AccessScope) {
  const address = await mailboxAddress(scope);
  if (address === undefined) return [];
  const masked = maskedAddress(address);
  const candidates = (await listVaultItems(scope)).filter(
    (item) => item.kind === "login" && item.account.endsWith(masked)
  );
  const checked = await Promise.all(
    candidates.map(async (item) =>
      (await broLogin(scope, item.id, address)) === undefined ? [] : [item.id]
    )
  );
  return checked.flat();
}

/**
 * One of Bro's own logins, read back for the person who owns the workspace:
 * its email and password, or undefined for anything else — another kind,
 * the person's own login, another workspace's item or no mailbox — with no
 * word on which.
 */
export async function revealBroLogin(scope: AccessScope, id: string) {
  const address = await mailboxAddress(scope);
  if (address === undefined) return undefined;
  const item = (await listVaultItems(scope)).find(
    (candidate) => candidate.id === id
  );
  if (item?.kind !== "login") return undefined;
  return broLogin(scope, item.id, address);
}
