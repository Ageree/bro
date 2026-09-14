import {
  decryptVaultSecret,
  encryptVaultSecret,
  tenantKey,
  vaultMasterKey,
} from "../shared/vaultCrypto.ts";
import {
  cardBrand,
  createVaultSetupUrl,
  defaultVaultLabel,
  isValidVaultSecret,
  originAllows,
  originHost,
  parseAddressPayload,
  parseLoginPayload,
  parsePaymentPayload,
  pickVaultLogin,
  vaultAccountHint,
  vaultAddedText,
  vaultItemOrigin,
  vaultSetupRequestSchema,
} from "../convex/lib/vaultPayload.ts";

import { assert, src, throws } from "./lib/check.ts";

const master = vaultMasterKey(Buffer.alloc(32, 7).toString("base64"));
const other = vaultMasterKey(Buffer.alloc(32, 9).toString("base64"));
const tenantA = "tenants|aaa";
const tenantB = "tenants|bbb";
const handle = "0f2f9a2c-0000-4000-8000-000000000001";

throws(() => vaultMasterKey(""), "empty key must throw");
throws(() => vaultMasterKey("c2hvcnQ="), "short key must throw");
assert(
  !tenantKey(master, tenantA).equals(tenantKey(master, tenantB)),
  "per-tenant keys must differ",
);
assert(
  tenantKey(master, tenantA).equals(tenantKey(master, tenantA)),
  "key derivation must be stable",
);
assert(
  !tenantKey(master, tenantA).equals(tenantKey(other, tenantA)),
  "master key must change the derived key",
);

const plaintext = JSON.stringify({ hello: "мир" });
const sealed = encryptVaultSecret(master, tenantA, handle, plaintext);
assert(sealed.startsWith("v1."), "ciphertext must be versioned");
assert(!sealed.includes("мир"), "ciphertext must not leak plaintext");
assert(
  decryptVaultSecret(master, tenantA, handle, sealed) === plaintext,
  "round trip",
);
assert(
  encryptVaultSecret(master, tenantA, handle, plaintext) !== sealed,
  "iv must be random",
);
throws(
  () => decryptVaultSecret(master, tenantB, handle, sealed),
  "another tenant must not decrypt",
);
throws(
  () => decryptVaultSecret(master, tenantA, `${handle}x`, sealed),
  "another handle must not decrypt",
);
throws(
  () => decryptVaultSecret(other, tenantA, handle, sealed),
  "another master key must not decrypt",
);
throws(
  () => decryptVaultSecret(master, tenantA, handle, `${sealed}AA`),
  "tampered ciphertext must not decrypt",
);
throws(
  () => decryptVaultSecret(master, tenantA, handle, "v2.a.b.c"),
  "unknown version must not decrypt",
);

const login = JSON.stringify({
  kind: "login",
  version: 1,
  origin: "https://www.wildberries.ru",
  identifier: { type: "email", value: "ivan.petrov@mail.ru" },
  authentication: { type: "password", password: "ochen-sekretno" },
});
const card = JSON.stringify({
  kind: "payment-card",
  version: 1,
  cardholderName: "IVAN PETROV",
  number: "2200123456789012",
  expirationMonth: 4,
  expirationYear: 2030,
  securityCode: "123",
});
const address = JSON.stringify({
  kind: "address",
  version: 1,
  recipientName: "Иван Петров",
  line1: "ул. Ленина, 1",
  city: "Москва",
  countryCode: "ru",
});
const contact = JSON.stringify({
  kind: "contact",
  version: 1,
  fullName: "Иван Петров",
});

assert(isValidVaultSecret("login", login), "login payload valid");
assert(isValidVaultSecret("payment", card), "payment payload valid");
assert(isValidVaultSecret("address", address), "address payload valid");
assert(isValidVaultSecret("contact", contact), "contact payload valid");
assert(!isValidVaultSecret("login", "not json"), "garbage rejected");
assert(!isValidVaultSecret("payment", login), "wrong kind rejected");
assert(
  !isValidVaultSecret(
    "contact",
    JSON.stringify({ kind: "contact", version: 1 }),
  ),
  "empty contact rejected",
);
assert(
  !isValidVaultSecret(
    "login",
    login.replace("https://www.wildberries.ru", "https://wb.ru/login"),
  ),
  "origin with a path rejected",
);
assert(
  !isValidVaultSecret("payment", card.replace('"123"', '"12"')),
  "short cvv rejected",
);
assert(
  !isValidVaultSecret("payment", card.replace("2200123456789012", "22001")),
  "short card number rejected",
);
assert(parseAddressPayload(address)?.countryCode === "RU", "country upcased");
assert(parseLoginPayload(login)?.origin === "https://www.wildberries.ru", "origin parsed");
assert(parsePaymentPayload(card)?.expirationMonth === 4, "expiry parsed");

const loginHint = vaultAccountHint("login", login);
assert(loginHint === "www.wildberries.ru · i•••@mail.ru", `login hint: ${loginHint}`);
assert(!loginHint.includes("ochen-sekretno"), "hint must not leak the password");
assert(!loginHint.includes("ivan.petrov"), "hint must not leak the identifier");

const cardHint = vaultAccountHint("payment", card);
assert(cardHint === "МИР · •••• 9012", `card hint: ${cardHint}`);
assert(!cardHint.includes("2200123456789012"), "hint must not leak the pan");
assert(!cardHint.includes("123"), "hint must not leak the cvv");

assert(vaultAccountHint("address", address) === "Москва · Иван Петров", "address hint");
assert(vaultAccountHint("contact", contact) === "Иван Петров", "contact hint");
throws(() => vaultAccountHint("login", "{}"), "incomplete login hint must throw");

assert(cardBrand("2204123412341234") === "МИР", "mir bin");
assert(cardBrand("4111111111111111") === "Visa", "visa bin");
assert(cardBrand("5500000000000004") === "Mastercard", "mastercard bin");
assert(cardBrand("9999999999999999") === "Карта", "unknown bin");
assert(originHost("https://www.ozon.ru") === "www.ozon.ru", "origin host");

assert(vaultItemOrigin("login", login) === "https://www.wildberries.ru", "login origin");
assert(vaultItemOrigin("payment", card) === undefined, "only logins bind an origin");

assert(defaultVaultLabel("payment", card) === "Карта", "default card label");
assert(defaultVaultLabel("address", address) === "Адрес", "default address label");
assert(defaultVaultLabel("contact", contact) === "Контакт", "default contact label");
assert(defaultVaultLabel("login", login) === "www.wildberries.ru", "default login label");
assert(defaultVaultLabel("login", "not json") === "Вход", "unparsable login label");

const setup = vaultSetupRequestSchema.parse({
  kind: "login",
  label: "Wildberries",
  identifierType: "email",
  origin: "https://www.wildberries.ru",
});
const setupUrl = new URL(createVaultSetupUrl("https://bro.example", setup));
assert(setupUrl.pathname === "/vault.html", "setup path");
assert(setupUrl.searchParams.get("kind") === "login", "setup kind");
assert(setupUrl.searchParams.get("identifier_type") === "email", "setup identifier type");
assert(
  setupUrl.searchParams.get("origin") === "https://www.wildberries.ru",
  "setup origin",
);
assert(
  !vaultSetupRequestSchema.safeParse({
    kind: "login",
    label: "WB",
    identifierType: "email",
    origin: "wildberries.ru",
  }).success,
  "setup rejects a bare host",
);
assert(
  vaultSetupRequestSchema.safeParse({ kind: "payment" }).success,
  "payment setup needs no label",
);

const addedText = vaultAddedText("payment", "Visa · •••• 4310");
assert(
  !!addedText?.includes("карта Visa · •••• 4310 добавлена"),
  `payment added text: ${addedText}`,
);
assert(
  !!addedText?.includes("Готов совершать покупки"),
  `payment added text ready phrase: ${addedText}`,
);
assert(originAllows("https://www.ozon.ru", "https://ozon.ru"), "www↔bare saved with www");
assert(originAllows("https://ozon.ru", "https://www.ozon.ru"), "www↔bare saved bare");
assert(originAllows("https://ozon.ru", "https://auth.ozon.ru"), "subdomain under parent");
assert(!originAllows("https://auth.ozon.ru", "https://ozon.ru"), "parent under saved subdomain denied");
assert(!originAllows("https://ozon.ru", "https://evil-ozon.ru"), "lookalike denied");
assert(!originAllows("http://ozon.ru", "https://ozon.ru"), "protocol mismatch denied");
assert(
  pickVaultLogin(
    [
      { kind: "login", origin: "https://ozon.ru", available: true },
      { kind: "login", origin: "https://www.wildberries.ru", available: true },
    ],
    "https://www.ozon.ru/login",
  )?.origin === "https://ozon.ru",
  "pickVaultLogin matches the page host",
);

assert(vaultAddedText("login", "www.wildberries.ru · i•••@mail.ru") === undefined, "login has no added text");
assert(vaultAddedText("address", "Москва · Иван Петров") === undefined, "address has no added text");
assert(vaultAddedText("contact", "Иван Петров") === undefined, "contact has no added text");

const vaultSrc = src("convex/vault.ts");
assert(vaultSrc.includes("export const listForAgent"), "agent can list vault items");
assert(vaultSrc.includes("export const replaceItem"), "vault logins can be edited");
assert(vaultSrc.includes("export const loginHandleByOrigin"), "same-origin login is replaced");
const secretsSrc = src("convex/vaultSecrets.ts");
assert(secretsSrc.includes("export const readForAgent"), "agent can read a vault secret");
assert(secretsSrc.includes("replaced: v.boolean()"), "save reports a replace");
const httpSrc = src("convex/http.ts");
assert(httpSrc.includes("replaced"), "cabinet save returns replaced");
const vaultPage = src("assets/vault.js");
assert(vaultPage.includes("item-edit"), "vault page can edit a login");
assert(vaultPage.includes("body.handle"), "edit posts the existing handle");

console.log("vault ok");
