/**
 * What to fill: vault payload to autofill tokens, and tokens to the Chromium
 * autofill parameters. Pure, so `npm run worker:check` can exercise the origin
 * binding and the token table without a browser or a Convex round trip.
 */
import {
  parseAddressPayload,
  parseContactPayload,
  parseLoginPayload,
  parsePaymentPayload,
  type VaultKind,
} from "../../../../../convex/lib/vaultPayload.ts";
import { nativeLoginAutofillTokens } from "./login.ts";
import type { AutofillClaim, DetectedAutofillSurface } from "./protocol.ts";

const cardTokens = [
  "cc-name",
  "cc-number",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
] as const;

const addressTokenToChromiumField = {
  name: "NAME_FULL",
  "street-address": "ADDRESS_HOME_STREET_ADDRESS",
  "address-line1": "ADDRESS_HOME_LINE1",
  "address-line2": "ADDRESS_HOME_LINE2",
  "address-level2": "ADDRESS_HOME_CITY",
  "address-level1": "ADDRESS_HOME_STATE",
  "postal-code": "ADDRESS_HOME_ZIP",
  country: "ADDRESS_HOME_COUNTRY",
} as const;

export const nativeAutofillTokens = {
  address: Object.keys(addressTokenToChromiumField),
  login: nativeLoginAutofillTokens,
  payment: [...cardTokens],
} as const;

export type NativeAutofillKind = "address" | "login" | "payment";

export type NativeAutofillPayload =
  | {
      card: {
        cvc: string;
        expiryMonth: string;
        expiryYear: string;
        name: string;
        number: string;
      };
    }
  | { address: { fields: { name: string; value: string }[] } };

export function buildNativeAutofillPayload(
  kind: "address" | "payment",
  claims: readonly Pick<AutofillClaim, "token" | "value">[],
): NativeAutofillPayload {
  const values = new Map(claims.map(({ token, value }) => [token, value]));

  if (kind === "payment") {
    return {
      card: {
        cvc: requiredClaim(values, "cc-csc"),
        expiryMonth: requiredClaim(values, "cc-exp-month"),
        expiryYear: requiredClaim(values, "cc-exp-year"),
        name: requiredClaim(values, "cc-name"),
        number: requiredClaim(values, "cc-number"),
      },
    };
  }

  const fields = Object.entries(addressTokenToChromiumField).flatMap(
    ([token, name]) => {
      const value = values.get(token);
      return value ? [{ name, value }] : [];
    },
  );
  if (fields.length === 0) {
    throw new Error("The saved address is incomplete or invalid.");
  }
  return { address: { fields } };
}

function requiredClaim(values: ReadonlyMap<string, string>, token: string) {
  const value = values.get(token);
  if (!value) throw new Error("The saved payment card is incomplete or invalid.");
  return value;
}

interface VaultAutofillCodec {
  readonly claims: (secret: string, origin: string) => ReadonlyMap<string, string>;
  readonly surfaceKinds: readonly DetectedAutofillSurface["kind"][];
  readonly vaultKind: VaultKind;
}

const codecs: readonly VaultAutofillCodec[] = [
  {
    claims(secret) {
      const card = parsePaymentPayload(secret);
      if (!card) {
        throw new Error("The saved payment card is incomplete or invalid.");
      }
      const values = new Map<string, string>([
        ["cc-name", card.cardholderName],
        ["cc-number", card.number],
        [
          "cc-exp",
          `${String(card.expirationMonth).padStart(2, "0")}/${String(card.expirationYear).slice(-2)}`,
        ],
        ["cc-exp-month", String(card.expirationMonth).padStart(2, "0")],
        ["cc-exp-year", String(card.expirationYear)],
        ["cc-csc", card.securityCode],
      ]);
      if (card.billingPostalCode) {
        values.set("postal-code", card.billingPostalCode);
      }
      return values;
    },
    surfaceKinds: ["payment-card"],
    vaultKind: "payment",
  },
  {
    claims(secret, origin) {
      const login = requireBoundLogin(secret, origin);
      const values = new Map<string, string>([
        ["username", login.identifier.value],
      ]);
      if (login.identifier.type === "email") {
        values.set("email", login.identifier.value);
      }
      if (login.identifier.type === "phone") {
        values.set("tel", login.identifier.value);
      }
      if (login.authentication.type === "password") {
        values.set("current-password", login.authentication.password);
      }
      return values;
    },
    surfaceKinds: ["credentials", "contact"],
    vaultKind: "login",
  },
  {
    claims(secret) {
      const address = parseAddressPayload(secret);
      if (!address) throw new Error("The saved address is incomplete or invalid.");

      const values = new Map<string, string>([
        ["name", address.recipientName],
        ["street-address", [address.line1, address.line2].filter(Boolean).join("\n")],
        ["address-line1", address.line1],
        ["address-level2", address.city],
        ["country", address.countryCode],
        ["country-name", countryName(address.countryCode)],
      ]);
      if (address.line2) values.set("address-line2", address.line2);
      if (address.region) values.set("address-level1", address.region);
      if (address.postalCode) values.set("postal-code", address.postalCode);
      return values;
    },
    surfaceKinds: ["postal-address", "identity"],
    vaultKind: "address",
  },
  {
    claims(secret) {
      const contact = parseContactPayload(secret);
      if (!contact) throw new Error("The saved contact is incomplete or invalid.");
      const values = new Map<string, string>();
      if (contact.fullName) values.set("name", contact.fullName);
      if (contact.email) values.set("email", contact.email);
      if (contact.phone) values.set("tel", contact.phone);
      return values;
    },
    surfaceKinds: ["contact", "identity"],
    vaultKind: "contact",
  },
];

export function vaultClaimValues(
  kind: VaultKind,
  secret: string,
  origin: string,
  surfaceKind: DetectedAutofillSurface["kind"],
): ReadonlyMap<string, string> {
  const codec = codecs.find(
    (candidate) =>
      candidate.vaultKind === kind && candidate.surfaceKinds.includes(surfaceKind),
  );
  if (!codec) {
    throw new Error("The selected vault item is not compatible with this form.");
  }
  return codec.claims(secret, origin);
}

function requireBoundLogin(secret: string, origin: string) {
  const login = parseLoginPayload(secret);
  if (!login) {
    throw new Error(
      "This saved login is not assigned to a website. Ask the coordinator to have it saved again.",
    );
  }
  if (login.origin !== origin) {
    throw new Error(`This saved login is restricted to ${login.origin}.`);
  }
  return login;
}

function countryName(countryCode: string) {
  try {
    return (
      new Intl.DisplayNames("ru", { type: "region" }).of(countryCode) ?? countryCode
    );
  } catch {
    return countryCode;
  }
}
