/**
 * Vault payload contracts shared by Convex, the worker autofill tools and the cabinet.
 *
 * A vault secret is always a JSON string in one of these shapes. The model never
 * sees a payload: it gets `handle`, `kind`, `label` and a masked `account` hint.
 */
import { z } from "zod";

export const vaultKindSchema = z.enum(["login", "payment", "address", "contact"]);
export type VaultKind = z.infer<typeof vaultKindSchema>;

const bounded = z.string().trim().min(1).max(2_000);
const optionalBounded = z
  .string()
  .trim()
  .max(2_000)
  .optional()
  .transform((value) => (value?.length ? value : undefined));

export const loginIdentifierTypeSchema = z.enum(["email", "phone", "username"]);

/** A bare origin such as https://www.wildberries.ru — no path, no query. */
export const originSchema = z
  .string()
  .trim()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  }, "origin must look like https://www.wildberries.ru");

export const loginPayloadSchema = z.object({
  kind: z.literal("login"),
  version: z.literal(1),
  origin: originSchema,
  identifier: z.object({
    type: loginIdentifierTypeSchema,
    value: z.string().trim().min(1).max(300),
  }),
  authentication: z.discriminatedUnion("type", [
    z.object({ type: z.literal("password"), password: z.string().min(1).max(2_000) }),
    z.object({ type: z.literal("email_otp") }),
    z.object({ type: z.literal("sms_otp") }),
  ]),
});

export const paymentPayloadSchema = z.object({
  kind: z.literal("payment-card"),
  version: z.literal(1),
  cardholderName: z.string().trim().min(1).max(200),
  number: z.string().regex(/^\d{12,19}$/),
  expirationMonth: z.number().int().min(1).max(12),
  expirationYear: z.number().int().min(2000).max(9999),
  securityCode: z.string().regex(/^\d{3,4}$/),
  billingPostalCode: optionalBounded,
});

export const addressPayloadSchema = z.object({
  kind: z.literal("address"),
  version: z.literal(1),
  recipientName: bounded,
  line1: bounded,
  line2: optionalBounded,
  city: bounded,
  region: optionalBounded,
  postalCode: optionalBounded,
  countryCode: z
    .string()
    .trim()
    .length(2)
    .default("RU")
    .transform((value) => value.toUpperCase()),
});

export const contactPayloadSchema = z
  .object({
    kind: z.literal("contact"),
    version: z.literal(1),
    fullName: optionalBounded,
    email: optionalBounded,
    phone: optionalBounded,
  })
  .refine((payload) => [payload.fullName, payload.email, payload.phone].some(Boolean), {
    message: "contact needs at least one value",
  });

export type LoginPayload = z.infer<typeof loginPayloadSchema>;
export type PaymentPayload = z.infer<typeof paymentPayloadSchema>;
export type AddressPayload = z.infer<typeof addressPayloadSchema>;
export type ContactPayload = z.infer<typeof contactPayloadSchema>;

function parseJson<T>(schema: z.ZodType<T>, value: string): T | undefined {
  try {
    return schema.safeParse(JSON.parse(value)).data;
  } catch {
    return undefined;
  }
}

export const parseLoginPayload = (value: string) => parseJson(loginPayloadSchema, value);
export const parsePaymentPayload = (value: string) => parseJson(paymentPayloadSchema, value);
export const parseAddressPayload = (value: string) => parseJson(addressPayloadSchema, value);
export const parseContactPayload = (value: string) => parseJson(contactPayloadSchema, value);

export function parseVaultSecret(kind: VaultKind, value: string) {
  switch (kind) {
    case "login":
      return parseLoginPayload(value);
    case "payment":
      return parsePaymentPayload(value);
    case "address":
      return parseAddressPayload(value);
    case "contact":
      return parseContactPayload(value);
  }
}

/** True when `secret` is a complete, well-formed payload for `kind`. */
export function isValidVaultSecret(kind: VaultKind, secret: string): boolean {
  return parseVaultSecret(kind, secret) !== undefined;
}

const CARD_BRANDS: readonly { name: string; test: RegExp }[] = [
  { name: "МИР", test: /^220[0-4]/ },
  { name: "Visa", test: /^4/ },
  { name: "Mastercard", test: /^(5[1-5]|2[2-7])/ },
  { name: "AmEx", test: /^3[47]/ },
  { name: "UnionPay", test: /^62/ },
];

export function cardBrand(number: string): string {
  const digits = number.replace(/\D/g, "");
  return CARD_BRANDS.find(({ test }) => test.test(digits))?.name ?? "Карта";
}

export function originHost(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function maskIdentifier(identifier: LoginPayload["identifier"]): string {
  const { type, value } = identifier;
  if (type === "email") {
    const [local, domain] = value.split("@", 2);
    return local && domain ? `${local.slice(0, 1)}•••@${domain}` : "почта";
  }
  if (type === "phone") return `тел. •••• ${value.replace(/\D/g, "").slice(-4)}`;
  return `${value.slice(0, 2)}•••`;
}

/**
 * Non-secret hint shown in the cabinet and given to the model with the handle.
 * Never contains a password, full card number, CVV or full identifier.
 */
export function vaultAccountHint(kind: VaultKind, secret: string): string {
  switch (kind) {
    case "login": {
      const login = parseLoginPayload(secret);
      if (!login) throw new Error("логин заполнен не полностью");
      return `${originHost(login.origin)} · ${maskIdentifier(login.identifier)}`;
    }
    case "payment": {
      const card = parsePaymentPayload(secret);
      if (!card) throw new Error("карта заполнена не полностью");
      return `${cardBrand(card.number)} · •••• ${card.number.slice(-4)}`;
    }
    case "address": {
      const address = parseAddressPayload(secret);
      if (!address) throw new Error("адрес заполнен не полностью");
      return [address.city, address.recipientName].filter(Boolean).join(" · ");
    }
    case "contact": {
      const contact = parseContactPayload(secret);
      if (!contact) throw new Error("контакт заполнен не полностью");
      return contact.fullName ?? contact.email ?? contact.phone ?? "";
    }
  }
}

/** Origin stored as non-secret metadata so autofill can bind a login to one site. */
export function vaultItemOrigin(kind: VaultKind, secret: string): string | undefined {
  if (kind !== "login") return undefined;
  return parseLoginPayload(secret)?.origin;
}

export const vaultSetupRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("login"),
    label: z.string().trim().min(1).max(120),
    identifierType: loginIdentifierTypeSchema,
    origin: originSchema,
  }),
  z.object({
    kind: z.enum(["payment", "address", "contact"]),
    label: z.string().trim().min(1).max(120).optional(),
  }),
]);

export type VaultSetupRequest = z.infer<typeof vaultSetupRequestSchema>;

/** Cabinet page the human opens to type the secret. The secret never travels over iMessage. */
export function createVaultSetupUrl(baseUrl: string, request: VaultSetupRequest): string {
  const url = new URL("/vault.html", baseUrl);
  url.searchParams.set("kind", request.kind);
  if (request.label) url.searchParams.set("label", request.label);
  if (request.kind === "login") {
    url.searchParams.set("identifier_type", request.identifierType);
    url.searchParams.set("origin", request.origin);
  }
  return url.toString();
}
