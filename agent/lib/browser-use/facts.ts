import type { AccessScope } from "@shared/identity/access-scope";
import {
  parseAddressVaultPayload,
  parseContactVaultPayload,
} from "@shared/vault/schema";
import { readAccountPhoneNumber } from "@db/services/users";
import { readUserProfile } from "@db/services/user-profile";
import { readVaultItems, readVaultSecret } from "@db/services/vault";

/**
 * The details a run may type into a form. These are not credentials: a name, a
 * phone number, an email address and a postal address are the same class of
 * data the workspace profile already hands to the browser. Logins and cards
 * never appear here — they travel as `secretBindings` and stay server-side.
 */
const factsHeader = "Known details you may type into forms:";

function fact(
  key: string,
  label: string | undefined,
  value: string | null | undefined
) {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  const named = label?.trim();
  return [{ key, label: named?.length ? named : undefined, value: trimmed }];
}

function profileFacts(profile: Awaited<ReturnType<typeof readUserProfile>>) {
  const name = [profile.firstName, profile.lastName]
    .filter((part) => part !== null)
    .join(" ");
  const address = [
    profile.addressLine1,
    profile.addressLine2,
    profile.postalCode,
    profile.city,
    profile.region,
    profile.countryCode,
  ]
    .filter((part) => part !== null)
    .join(", ");
  return [
    ...fact("Name", undefined, name),
    ...fact("Phone", undefined, profile.phone),
    ...fact("Email", undefined, profile.email),
    ...fact("Address", undefined, address),
  ];
}

function vaultCardFacts(
  card: { readonly kind: string; readonly label: string },
  secret: string | undefined
) {
  if (!secret) return [];
  if (card.kind === "contact") {
    const contact = parseContactVaultPayload(secret);
    if (!contact) return [];
    return [
      ...fact("Name", card.label, contact.fullName),
      ...fact("Phone", card.label, contact.phone),
      ...fact("Email", card.label, contact.email),
      ...fact("Date of birth", card.label, contact.dateOfBirth),
    ];
  }
  const address = parseAddressVaultPayload(secret);
  if (!address) return [];
  return fact(
    "Address",
    card.label,
    [
      address.recipientName,
      address.line1,
      address.line2,
      address.postalCode,
      address.city,
      address.region,
      address.countryCode,
    ]
      .filter((part) => part !== undefined)
      .join(", ")
  );
}

/**
 * The vault's own contact and address cards. Their labels travel with them so
 * a run pointed at two saved addresses can pick «Домашний адрес» over
 * «Рабочий» instead of stopping to ask which one the person meant.
 */
async function vaultFacts(scope: AccessScope) {
  const items = (await readVaultItems(scope)).filter(
    (item) =>
      item.hasSecret && (item.kind === "contact" || item.kind === "address")
  );
  const secrets = await Promise.all(
    items.map(async (item) => ({
      item,
      secret: await readVaultSecret(scope, item.id),
    }))
  );
  return secrets.flatMap(({ item, secret }) => vaultCardFacts(item, secret));
}

async function safeVaultFacts(scope: AccessScope) {
  try {
    return await vaultFacts(scope);
  } catch (error) {
    console.warn("[browser-use] vault facts could not be read", {
      cause: error,
    });
    return [];
  }
}

async function safeAccountPhoneNumber(scope: AccessScope) {
  try {
    return await readAccountPhoneNumber(scope);
  } catch (error) {
    console.warn("[browser-use] the account phone could not be read", {
      cause: error,
    });
    return undefined;
  }
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/**
 * Where the person lives, in words a site's own country picker would use:
 * «Moscow, Russia» rather than a code. Only the profile's own city and
 * country count: the vault can hold several addresses with none marked as
 * home, and the errand text names any other place it is about.
 */
function profileHome(profile: Awaited<ReturnType<typeof readUserProfile>>) {
  const code = profile.countryCode?.toUpperCase();
  const country = code ? (regionNames.of(code) ?? code) : undefined;
  const parts = [profile.city ?? undefined, country].filter(
    (part) => part !== undefined
  );
  return parts.length === 0 ? undefined : parts.join(", ");
}

/**
 * Everything the run is allowed to know about the person. `details` is one
 * block of form values: the profile comes first, then the vault's contact and
 * address cards, and the account's own sign-in phone only when nothing else
 * supplied one — the errand that stalls on «номер телефона для входа» is the
 * case this last line exists for. `home` is the profile's city and country,
 * which decide which sites can serve the errand at all.
 */
export async function browserRunFacts(scope: AccessScope) {
  const [profile, vault, accountPhone] = await Promise.all([
    readUserProfile(scope),
    safeVaultFacts(scope),
    safeAccountPhoneNumber(scope),
  ]);
  const known = [...profileFacts(profile), ...vault];
  const facts = known.some((entry) => entry.key === "Phone")
    ? known
    : [...known, ...fact("Phone", undefined, accountPhone)];

  const seen = new Set<string>();
  const lines = facts
    .filter((entry) => {
      const key = `${entry.key}\u0000${entry.value}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(
      (entry) =>
        `${entry.key}${entry.label ? ` (${entry.label})` : ""}: ${entry.value}`
    );
  return {
    details:
      lines.length === 0 ? undefined : [factsHeader, ...lines].join("\n"),
    home: profileHome(profile),
  };
}
