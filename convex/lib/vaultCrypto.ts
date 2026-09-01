/**
 * Vault secret encryption.
 *
 * One master key per deployment (`BRO_VAULT_KEY`), one derived key per tenant.
 * Deriving per tenant means a leaked ciphertext row cannot be decrypted with a
 * key recovered for another tenant, and the AAD binds every ciphertext to the
 * exact tenant and item it was written for.
 *
 * Node-only: imported from Convex `"use node"` actions and from check scripts,
 * never from a query or mutation.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const SALT = "bro-vault-v1";

export function vaultMasterKey(raw = process.env.BRO_VAULT_KEY): Buffer {
  const value = raw?.trim();
  if (!value) throw new Error("BRO_VAULT_KEY missing");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("BRO_VAULT_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function tenantKey(master: Buffer, tenantId: string): Buffer {
  if (!tenantId) throw new Error("tenantId required for vault key derivation");
  return Buffer.from(hkdfSync("sha256", master, SALT, `tenant:${tenantId}`, 32));
}

export function vaultAad(tenantId: string, handle: string): Buffer {
  return Buffer.from(`${tenantId}\u0000vault\u0000${handle}`);
}

export function encryptVaultSecret(
  master: Buffer,
  tenantId: string,
  handle: string,
  plaintext: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tenantKey(master, tenantId), iv);
  cipher.setAAD(vaultAad(tenantId, handle));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

export function decryptVaultSecret(
  master: Buffer,
  tenantId: string,
  handle: string,
  ciphertext: string,
): string {
  const [version, iv, tag, body] = ciphertext.split(".");
  if (version !== VERSION || !iv || !tag || !body) {
    throw new Error("stored secret uses an unsupported format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    tenantKey(master, tenantId),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(vaultAad(tenantId, handle));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
