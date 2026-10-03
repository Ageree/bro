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

type Profile = Awaited<ReturnType<typeof readUserProfile>>;

function joinedAddress(parts: readonly (string | null | undefined)[]) {
  return parts.filter((part) => part !== null && part !== undefined).join(", ");
}

function profileAddress(profile: Profile) {
  return joinedAddress([
    profile.addressLine1,
    profile.addressLine2,
    profile.postalCode,
    profile.city,
    profile.region,
    profile.countryCode,
  ]);
}

function profileFacts(profile: Profile) {
  const name = [profile.firstName, profile.lastName]
    .filter((part) => part !== null)
    .join(" ");
  return [
    ...fact("Name", undefined, name),
    ...fact("Phone", undefined, profile.phone),
    ...fact("Email", undefined, profile.email),
    ...fact("Address", undefined, profileAddress(profile)),
  ];
}

/** A vault card the run may use, read and parsed once. */
type VaultCard =
  | {
      readonly contact: NonNullable<
        ReturnType<typeof parseContactVaultPayload>
      >;
      readonly kind: "contact";
      readonly label: string;
    }
  | {
      readonly address: NonNullable<
        ReturnType<typeof parseAddressVaultPayload>
      >;
      readonly kind: "address";
      readonly label: string;
    };

function parsedVaultCard(
  item: { readonly kind: string; readonly label: string },
  secret: string | undefined
): VaultCard[] {
  if (!secret) return [];
  if (item.kind === "contact") {
    const contact = parseContactVaultPayload(secret);
    return contact ? [{ contact, kind: "contact", label: item.label }] : [];
  }
  const address = parseAddressVaultPayload(secret);
  return address ? [{ address, kind: "address", label: item.label }] : [];
}

function vaultCardFacts(card: VaultCard) {
  if (card.kind === "contact") {
    return [
      ...fact("Name", card.label, card.contact.fullName),
      ...fact("Phone", card.label, card.contact.phone),
      ...fact("Email", card.label, card.contact.email),
      ...fact("Date of birth", card.label, card.contact.dateOfBirth),
    ];
  }
  const { address } = card;
  return fact(
    "Address",
    card.label,
    joinedAddress([
      address.recipientName,
      address.line1,
      address.line2,
      address.postalCode,
      address.city,
      address.region,
      address.countryCode,
    ])
  );
}

/**
 * The vault's own contact and address cards. Their labels travel with them so
 * a run pointed at two saved addresses can pick «Домашний адрес» over
 * «Рабочий» instead of stopping to ask which one the person meant.
 */
async function vaultCards(scope: AccessScope) {
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
  return secrets.flatMap(({ item, secret }) => parsedVaultCard(item, secret));
}

async function safeVaultCards(scope: AccessScope) {
  try {
    return await vaultCards(scope);
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

/**
 * The person's own phone, to sign in with where the site sends a code: the
 * one in Personal Info, else the one they signed in to Bro with. A vault
 * contact card's phone may be someone else's, so it never stands in.
 */
function ownPhone(profile: Profile, accountPhone: string | null | undefined) {
  const phone = [profile.phone, accountPhone]
    .map((value) => value?.replaceAll(/\s+/gu, " ").trim())
    .find((value) => value !== undefined && value.length > 0);
  return phone;
}

/**
 * Where the person's things can be delivered: the profile's street address
 * first, then the vault's address cards, each without the recipient's name.
 * A city and a country alone are not an address — they are the `home` line.
 */
function deliveryAddresses(profile: Profile, cards: readonly VaultCard[]) {
  const addresses = [
    ...(profile.addressLine1 === null
      ? []
      : fact("Address", undefined, profileAddress(profile))),
    ...cards.flatMap((card) =>
      card.kind === "address"
        ? fact(
            "Address",
            card.label,
            joinedAddress([
              card.address.line1,
              card.address.line2,
              card.address.postalCode,
              card.address.city,
              card.address.region,
              card.address.countryCode,
            ])
          )
        : []
    ),
  ];
  const seen = new Set<string>();
  return addresses
    .filter((entry) => {
      const key = entry.value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((entry) => ({
      label: entry.label,
      // Free text from a form, and the address is one line of the run's
      // instructions: a line break would start a paragraph of its own.
      value: entry.value.replaceAll(/\s+/gu, " "),
    }));
}

/**
 * The one delivery address an errand without a card may type: the saved
 * one the errand names by its label («на дачу» with a card «Дача»), or else
 * the first — the profile's own, then the vault's. The person's other
 * addresses are theirs to hand over on a card, not all at once to a search.
 */
export function deliveryAddressFor(
  addresses: readonly { readonly label?: string; readonly value: string }[],
  ...texts: readonly (string | null | undefined)[]
) {
  const said = texts.join("\n").toLocaleLowerCase();
  const named = addresses.find(
    (address) => address.label !== undefined && labelNamed(address.label, said)
  );
  return (named ?? addresses[0])?.value;
}

/**
 * Whether the text names a card by its label, in any case form: «на дачу»
 * names «Дача», «на работу» names «Работа». Every word of the label counts,
 * without its last letter once it is long enough to have an ending.
 */
function labelNamed(label: string, said: string) {
  const words = label
    .toLocaleLowerCase()
    .split(/[^\p{L}\d]+/u)
    .filter((word) => word.length > 0);
  return (
    words.length > 0 &&
    words.every((word) =>
      new RegExp(
        `(?<![\\p{L}\\d])${word.length >= 4 ? word.slice(0, -1) : word}`,
        "u"
      ).test(said)
    )
  );
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/**
 * Where the person lives, in words a site's own country picker would use:
 * «Moscow, Russia» rather than a code. Only the profile's own city and
 * country count: the vault can hold several addresses with none marked as
 * home, and the errand text names any other place it is about.
 */
function profileHome(profile: Profile) {
  const code = profile.countryCode?.toUpperCase();
  const country = code ? (regionNames.of(code) ?? code) : undefined;
  // The city is free text from a form, and it lands inside a sentence of the
  // run's instructions: a line break there would start a paragraph of its own.
  const city = profile.city?.replaceAll(/\s+/gu, " ").trim();
  const parts = [city, country].filter(
    (part) => part !== undefined && part.length > 0
  );
  return parts.length === 0 ? undefined : parts.join(", ");
}

/**
 * Everything the run is allowed to know about the person. `details` is one
 * block of form values: the profile comes first, then the vault's contact and
 * address cards, and the account's own sign-in phone only when nothing else
 * supplied one — the errand that stalls on «номер телефона для входа» is the
 * case this last line exists for. `home` is the profile's city and country,
 * which decide which sites can serve the errand at all. `addresses` are the
 * delivery addresses alone, with no name, phone or email: one of them
 * (`deliveryAddressFor`) is what a delivery errand may type into a site's
 * address picker before anyone confirmed an order.
 */
export async function browserRunFacts(scope: AccessScope) {
  const [profile, cards, accountPhone] = await Promise.all([
    readUserProfile(scope),
    safeVaultCards(scope),
    safeAccountPhoneNumber(scope),
  ]);
  const known = [...profileFacts(profile), ...cards.flatMap(vaultCardFacts)];
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
    addresses: deliveryAddresses(profile, cards),
    details:
      lines.length === 0 ? undefined : [factsHeader, ...lines].join("\n"),
    home: profileHome(profile),
  };
}

/** A value a form gave, if it gave one. */
function present(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? [trimmed] : [];
}

/**
 * The person's own phones and email: the phone in Personal Info and the one
 * they signed in to Bro with, and Personal Info's email. A vault contact
 * card's may be someone else's. Names are not here: «Иван», «Роза» or
 * «Лебедев» is a street, a shop or a hotel as often as the person.
 */
export async function readOwnContacts(scope: AccessScope) {
  const [profile, accountPhone] = await Promise.all([
    readUserProfile(scope),
    safeAccountPhoneNumber(scope),
  ]);
  return {
    emails: present(profile.email),
    phones: [profile.phone, accountPhone].flatMap(present),
  };
}

const ownPhonePlaceholder = "[телефон человека не передаётся]";
const ownEmailPlaceholder = "[почта человека не передаётся]";

/** A digit as typed, or full-width («９»). */
const anyDigit = String.raw`[\d\uFF10-\uFF19]`;

/**
 * What people put between a phone's digits: spaces, brackets, dots, dashes,
 * slashes and underscores, a few of them at a time.
 */
const phoneSeparator = String.raw`[\s()./_\-\u2010-\u2015\u2212]{0,6}`;

/**
 * A run of digits a phone field writes as one number or as several, with
 * the matcher's own separators: «+7 (999) 000-00-01 8 495 123 45 67». A
 * comma, a word or a plus ends it, so «…01, рабочий +7 495…» is two runs and
 * «…01 после 18:00» leaves the time out.
 */
const digitRunPattern = new RegExp(
  `${anyDigit}(?:${phoneSeparator}${anyDigit})*`,
  "gu"
);

/**
 * The numbers of one run, read group by group in the order written: groups
 * add up until they hold a number — ten digits, or eleven or twelve with a
 * country code («8», «+7», «+44») — and the next group starts the next one.
 * Seven to nine digits left over are a short number of their own. Only
 * digits written together with nothing between them, too many for one
 * number, are split blindly: every ten of them in a row count.
 */
function runNumbers(groups: readonly string[]) {
  const numbers: string[] = [];
  let pending = "";
  for (const group of groups) {
    pending += group;
    if (pending.length < 10) continue;
    numbers.push(
      ...(pending.length <= 12
        ? [pending.slice(-10)]
        : Array.from({ length: pending.length - 9 }, (_, from) =>
            pending.slice(from, from + 10)
          ))
    );
    pending = "";
  }
  return pending.length >= 7 ? [...numbers, pending] : numbers;
}

/**
 * The numbers a phone field holds, each by its last ten digits or, written
 * shorter, by all of them. The field is free text, up to a work number, an
 * extension or the hours to call.
 */
function phoneNumbers(phone: string) {
  return [...phone.matchAll(digitRunPattern)].flatMap(([run]) =>
    runNumbers(
      run
        .normalize("NFKC")
        .split(/\D+/u)
        .filter((group) => group.length > 0)
    )
  );
}

/** The distinct numbers of the person's phone fields. */
function ownPhoneNumbers(phones: readonly string[]) {
  return [...new Set(phones.flatMap(phoneNumbers))];
}

/** One digit of a phone, as typed or full-width. */
function phoneDigit(digit: string) {
  return `[${digit}${String.fromCodePoint(0xff10 + Number(digit))}]`;
}

/**
 * The country code before a number: «+7», «+44», «(+7)», «007» or «8». A
 * bare small number is not one: «дом 5 / 999 000 00 01» keeps its «5».
 */
const countryCode = String.raw`(?:\([+\uFF0B]?${anyDigit}{1,3}\)|[+\uFF0B]${anyDigit}{1,3}|00${anyDigit}{1,3}|[78\uFF17\uFF18])${phoneSeparator}`;

/**
 * A phone as people write it: «+7 999 000-00-01», «8 (999) 000 00 01»,
 * «(+7) 999/000/00/01» and «9990000001» are all «+79990000001». Brackets
 * round the country or the area code go with it, so no stray «(» is left.
 */
function phonePattern(number: string) {
  const digits = Array.from(number, phoneDigit);
  const area = digits.slice(0, 3).join(phoneSeparator);
  const rest = digits.slice(3).join(phoneSeparator);
  return new RegExp(
    String.raw`(?<!${anyDigit})(?:${countryCode})?(?:\(${phoneSeparator}${area}${phoneSeparator}\)|${area})${phoneSeparator}${rest}(?!${anyDigit})`,
    "gu"
  );
}

/** Text that a regular expression matches as written. */
function literally(text: string) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/**
 * An email in any case, with «%40» for its «@» as a link writes it, and
 * with the plus-addresses of the same mailbox: «ivan+shop@…» is ivan@…. A
 * leading «+» is part of the mailbox's name, not a tag. Not inside a longer
 * address.
 */
function emailPattern(email: string) {
  const at = email.lastIndexOf("@");
  if (at < 1) return [];
  const local = email.slice(0, at);
  const tag = local.indexOf("+", 1);
  const mailbox = tag === -1 ? local : local.slice(0, tag);
  return [
    new RegExp(
      String.raw`(?<![\p{L}\p{N}._%+\-])${literally(mailbox)}(?:\+[\p{L}\p{N}._\-]*)?(?:@|%40)${literally(email.slice(at + 1))}(?![\p{L}\p{N}_\-]|\.[\p{L}\p{N}])`,
      "giu"
    ),
  ];
}

/**
 * The person's contacts less those they wrote themselves this turn (`words`):
 * those are theirs to pass on, and Bro saying them again passes on nothing
 * new. Phones come back as their numbers.
 */
export function contactsNotIn(
  own: Awaited<ReturnType<typeof readOwnContacts>>,
  words: readonly string[]
) {
  const said = words.join("\n");
  return {
    emails: own.emails.filter((email) =>
      emailPattern(email).every((pattern) => said.search(pattern) === -1)
    ),
    phones: ownPhoneNumbers(own.phones).filter(
      (number) => said.search(phonePattern(number)) === -1
    ),
  };
}

/**
 * The model's own words for a run without the person's phone and email in
 * them, and whether each was there. A run that may not type their details
 * is told so, but a number in the errand text is text the run hands to any
 * page (`signin_phone` exists so that the phone it signs in with is bound to
 * one site only). Emails go first: «79990000001@mail.ru» is an address, not
 * a phone.
 */
export function withoutOwnContacts(
  text: string,
  own: Awaited<ReturnType<typeof readOwnContacts>>
) {
  const withoutEmails = own.emails
    .flatMap(emailPattern)
    .reduce(
      (cut, pattern) => cut.replaceAll(pattern, ownEmailPlaceholder),
      text
    );
  const withoutPhones = ownPhoneNumbers(own.phones)
    .map(phonePattern)
    .reduce(
      (cut, pattern) => cut.replaceAll(pattern, ownPhonePlaceholder),
      withoutEmails
    );
  return {
    email: withoutEmails !== text,
    phone: withoutPhones !== withoutEmails,
    text: withoutPhones,
  };
}

/**
 * The person's own phone, to sign in with where the site sends a code: the
 * one in Personal Info, else the one they signed in to Bro with.
 */
export async function readOwnPhone(scope: AccessScope) {
  try {
    const [profile, accountPhone] = await Promise.all([
      readUserProfile(scope),
      safeAccountPhoneNumber(scope),
    ]);
    return ownPhone(profile, accountPhone);
  } catch (error) {
    // No phone to sign in with is the run as it was before: the errand
    // still starts, and a sign-in stops with NEEDS: password.
    console.warn("[browser-use] the person's phone could not be read", {
      cause: error,
    });
    return undefined;
  }
}
