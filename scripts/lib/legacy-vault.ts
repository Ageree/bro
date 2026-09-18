import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import {
  serializeAddressVaultPayload,
  serializeContactVaultPayload,
  serializeLoginVaultPayload,
  serializePaymentCard,
  type VaultCreateItem,
} from "@shared/vault/schema";

/**
 * The old product's vault encryption, ported unchanged so this import can read
 * what that deployment wrote: one master key (`BRO_VAULT_KEY`), one key per
 * tenant derived with HKDF-SHA256, and an AAD that binds every ciphertext to
 * the tenant and the item handle it was written for. Nothing here re-encrypts
 * for the new product — the vault service owns that with the installation key.
 */
const legacyVersion = "v1";
const legacyKeySalt = "bro-vault-v1";

/** The old deployment's `BRO_VAULT_KEY`, base64-encoded 32 bytes. */
export function legacyVaultMasterKey(value: string | undefined) {
  const raw = value?.trim();
  if (!raw) {
    throw new Error(
      "BRO_VAULT_KEY is required to migrate vault items. Pass --skip-vault to import everything else."
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("BRO_VAULT_KEY must be a base64-encoded 32-byte key.");
  }
  return key;
}

function legacyTenantKey(master: Buffer, tenantId: string) {
  if (!tenantId) {
    throw new Error("A tenant id is required to derive the legacy vault key.");
  }
  return Buffer.from(
    hkdfSync("sha256", master, legacyKeySalt, `tenant:${tenantId}`, 32)
  );
}

function legacyVaultAad(tenantId: string, handle: string) {
  return Buffer.from(`${tenantId}\u0000vault\u0000${handle}`);
}

export function decryptLegacyVaultSecret(
  master: Buffer,
  tenantId: string,
  handle: string,
  ciphertext: string
) {
  const [version, iv, tag, body] = ciphertext.split(".");
  if (version !== legacyVersion || !iv || !tag || !body) {
    throw new Error("The stored secret uses an unsupported format.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    legacyTenantKey(master, tenantId),
    Buffer.from(iv, "base64url")
  );
  decipher.setAAD(legacyVaultAad(tenantId, handle));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * The write half of the same scheme. Production never calls it: it exists so a
 * test can build a Convex export that the decrypt path has to earn its way
 * through, rather than asserting against a ciphertext checked into the tree.
 */
export function encryptLegacyVaultSecret(
  master: Buffer,
  tenantId: string,
  handle: string,
  plaintext: string
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    legacyTenantKey(master, tenantId),
    iv
  );
  cipher.setAAD(legacyVaultAad(tenantId, handle));
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    legacyVersion,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

const legacyOptionalValue = z
  .string()
  .trim()
  .max(2_000)
  .optional()
  .transform((value) => (value?.length ? value : undefined));

const legacyLoginPayloadSchema = z.object({
  authentication: z.discriminatedUnion("type", [
    z.object({
      password: z.string().min(1).max(2_000),
      type: z.literal("password"),
    }),
    z.object({ type: z.literal("email_otp") }),
    z.object({ type: z.literal("sms_otp") }),
  ]),
  identifier: z.object({
    type: z.enum(["email", "phone", "username"]),
    value: z.string().trim().min(1).max(300),
  }),
  kind: z.literal("login"),
  origin: z.string().trim(),
  version: z.literal(1),
});

const legacyPaymentPayloadSchema = z.object({
  billingPostalCode: legacyOptionalValue,
  cardholderName: z.string().trim().min(1).max(200),
  expirationMonth: z.number().int().min(1).max(12),
  expirationYear: z.number().int().min(2000).max(9999),
  kind: z.literal("payment-card"),
  number: z.string().regex(/^\d{12,19}$/u),
  securityCode: z.string().regex(/^\d{3,4}$/u),
  version: z.literal(1),
});

const legacyAddressPayloadSchema = z.object({
  city: z.string().trim().min(1).max(2_000),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .default("RU")
    .transform((value) => value.toUpperCase()),
  kind: z.literal("address"),
  line1: z.string().trim().min(1).max(2_000),
  line2: legacyOptionalValue,
  postalCode: legacyOptionalValue,
  recipientName: z.string().trim().min(1).max(2_000),
  region: legacyOptionalValue,
  version: z.literal(1),
});

const legacyContactPayloadSchema = z.object({
  email: legacyOptionalValue,
  fullName: legacyOptionalValue,
  kind: z.literal("contact"),
  phone: legacyOptionalValue,
  version: z.literal(1),
});

/** The four kinds the old vault stored; the new vault keeps all four names. */
export type LegacyVaultKind = "address" | "contact" | "login" | "payment";

/**
 * Translates one decrypted legacy payload into the item the new vault service
 * takes. The two payload contracts differ in three places, and each of them
 * raises rather than inventing a value: logins gained a payload version, cards
 * made the billing postal code mandatory, and addresses made the region and
 * the postal code mandatory. No message here carries plaintext.
 */
export function legacyVaultCreateItem(
  kind: LegacyVaultKind,
  label: string,
  plaintext: string
): VaultCreateItem {
  switch (kind) {
    case "login": {
      const login = decodeLegacyPayload(legacyLoginPayloadSchema, plaintext);
      return {
        account: "",
        kind: "login",
        label,
        secret: serializeForTarget(() =>
          serializeLoginVaultPayload({
            authentication: login.authentication,
            identifier: login.identifier,
            kind: "login",
            origin: login.origin,
            version: 2,
          })
        ),
      };
    }
    case "payment": {
      const card = decodeLegacyPayload(legacyPaymentPayloadSchema, plaintext);
      const { billingPostalCode } = card;
      if (billingPostalCode === undefined) {
        throw new Error(
          "the saved card has no billing postal code, which the new vault requires"
        );
      }
      return {
        account: "",
        kind: "payment",
        label,
        secret: serializeForTarget(() =>
          serializePaymentCard({
            billingPostalCode,
            cardholderName: card.cardholderName,
            expirationMonth: card.expirationMonth,
            expirationYear: card.expirationYear,
            kind: "payment-card",
            number: card.number,
            securityCode: card.securityCode,
            version: 1,
          })
        ),
      };
    }
    case "address": {
      const address = decodeLegacyPayload(
        legacyAddressPayloadSchema,
        plaintext
      );
      const { postalCode, region } = address;
      if (region === undefined || postalCode === undefined) {
        throw new Error(
          "the saved address has no region or postal code, which the new vault requires"
        );
      }
      return {
        account: "",
        kind: "address",
        label,
        secret: serializeForTarget(() =>
          serializeAddressVaultPayload({
            city: address.city,
            countryCode: address.countryCode,
            kind: "address",
            line1: address.line1,
            line2: address.line2,
            postalCode,
            recipientName: address.recipientName,
            region,
            version: 1,
          })
        ),
      };
    }
    case "contact": {
      const contact = decodeLegacyPayload(
        legacyContactPayloadSchema,
        plaintext
      );
      return {
        account: "",
        kind: "contact",
        label,
        secret: serializeForTarget(() =>
          serializeContactVaultPayload({
            email: contact.email,
            fullName: contact.fullName,
            kind: "contact",
            phone: contact.phone,
            version: 1,
          })
        ),
      };
    }
  }
  throw new Error("Unsupported legacy vault item kind.");
}

function decodeLegacyPayload<T>(schema: z.ZodType<T>, plaintext: string): T {
  const parsed = schema.safeParse(readJson(plaintext));
  if (!parsed.success) {
    throw new Error(
      `the decrypted payload does not match the legacy contract (${describeIssues(parsed.error)})`
    );
  }
  return parsed.data;
}

/**
 * Runs one target serializer. Everything this module handles is plaintext, so
 * a rejection is reported as the field paths and issue codes that failed and
 * never as the value that failed them.
 */
function serializeForTarget(serialize: () => string): string {
  try {
    return serialize();
  } catch (error) {
    throw new Error(
      `the mapped payload was rejected by the new vault contract (${
        error instanceof z.ZodError ? describeIssues(error) : "unknown issue"
      })`,
      { cause: error }
    );
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")} ${issue.code}`)
    .join("; ");
}

function readJson(plaintext: string) {
  try {
    return z.json().parse(JSON.parse(plaintext));
  } catch {
    throw new Error("the decrypted payload is not valid JSON");
  }
}
