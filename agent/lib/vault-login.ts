/**
 * Fetch a matching vault password login for a page and turn it into
 * Browser Use secretBindings. The plaintext never goes to iMessage.
 */
import { loginPageUrl } from "../../convex/lib/browserProfilePolicy.ts";
import { parseLoginPayload, pickVaultLogin } from "../../convex/lib/vaultPayload.ts";
import { loginBindings, normalizePayHosts, type SecretBinding } from "./browser-pay.ts";
import { listVaultItems, readVaultSecret } from "./convex.ts";

export type VaultLoginBinding = {
  handle: string;
  account: string;
  hosts: string[];
  bindings: SecretBinding[];
};

export async function vaultPasswordLogin(
  phone: string,
  pageUrl: string,
): Promise<VaultLoginBinding | undefined> {
  const page = loginPageUrl(pageUrl);
  if (!page) return undefined;
  let items;
  try {
    items = await listVaultItems(phone);
  } catch (err) {
    console.error("vault list for login failed", err);
    return undefined;
  }
  const match = pickVaultLogin(items, page);
  if (!match) return undefined;
  let record;
  try {
    record = await readVaultSecret(phone, match.handle);
  } catch (err) {
    console.error("vault read for login failed", err);
    return undefined;
  }
  const payload = record?.secret ? parseLoginPayload(record.secret) : undefined;
  if (!payload || payload.authentication.type !== "password") return undefined;
  const hosts = normalizePayHosts([page, payload.origin]);
  if (hosts.length === 0) return undefined;
  return {
    handle: match.handle,
    account: match.account,
    hosts,
    bindings: loginBindings(payload, hosts),
  };
}

export async function vaultPasswordLoginForPages(
  phone: string,
  pages: readonly string[],
): Promise<VaultLoginBinding | undefined> {
  const seen = new Set<string>();
  for (const raw of pages) {
    const page = loginPageUrl(raw);
    if (!page || seen.has(page)) continue;
    seen.add(page);
    const found = await vaultPasswordLogin(phone, page);
    if (found) return found;
  }
  return undefined;
}
