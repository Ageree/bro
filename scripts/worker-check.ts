import {
  buildNativeAutofillPayload,
  nativeAutofillTokens,
  vaultClaimValues,
} from "../agent/subagents/worker/lib/autofill/claims.ts";
import {
  classifyNativeLoginControl,
  selectNativeLoginFills,
  type NativeLoginControlDescriptor,
} from "../agent/subagents/worker/lib/autofill/login.ts";
import {
  kernel,
  kernelEnabled,
  kernelRegion,
  profileNameForTenant,
  proxyCountry,
  proxyNameForCountry,
} from "../agent/subagents/worker/lib/kernel.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function throws(fn: () => unknown, contains: string, msg: string): void {
  try {
    fn();
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    assert(text.includes(contains), `${msg}: got "${text}"`);
    return;
  }
  throw new Error(msg);
}

const PHONE = "+79001112233";

assert(profileNameForTenant(PHONE).startsWith("bro-"), "profile prefix");
assert(!profileNameForTenant(PHONE).includes("7900"), "profile must not leak the phone");
assert(
  profileNameForTenant(PHONE) === profileNameForTenant(PHONE),
  "profile name is stable",
);
assert(
  profileNameForTenant(PHONE) !== profileNameForTenant("+79004445566"),
  "profile name is per tenant",
);

assert(proxyCountry(undefined) === "RU", "russian proxy by default");
assert(proxyCountry("ru") === "RU", "country upcased");
assert(proxyCountry("de") === "DE", "country override");
assert(proxyCountry("none") === undefined, "proxy can be switched off");
assert(proxyCountry("россия") === undefined, "invalid country ignored");
assert(proxyNameForCountry("RU") === "bro-residential-ru", "proxy name");

assert(kernelRegion("eu-west") === "eu-west", "known region");
assert(kernelRegion("moon") === undefined, "unknown region ignored");
assert(kernelRegion(undefined) === undefined, "region is opt-in");

const savedKey = process.env.KERNEL_API_KEY;
delete process.env.KERNEL_API_KEY;
assert(!kernelEnabled(), "kernel disabled without a key");
throws(() => kernel(), "KERNEL_API_KEY", "kernel must fail loudly without a key");
if (savedKey !== undefined) process.env.KERNEL_API_KEY = savedKey;

function control(
  over: Partial<NativeLoginControlDescriptor>,
): NativeLoginControlDescriptor {
  return {
    autocomplete: "",
    focused: false,
    formIndex: 0,
    index: 0,
    label: "",
    name: "",
    type: "text",
    ...over,
  };
}

assert(
  classifyNativeLoginControl(control({ autocomplete: "new-password" })) === null,
  "never fill a new-password field",
);
assert(
  classifyNativeLoginControl(control({ autocomplete: "one-time-code" })) === null,
  "never fill an OTP field",
);
assert(
  classifyNativeLoginControl(control({ type: "password" }))?.token ===
    "current-password",
  "password input",
);
assert(
  classifyNativeLoginControl(control({ label: "Confirm password", type: "password" })) ===
    null,
  "confirm password rejected",
);
assert(
  classifyNativeLoginControl(
    control({ label: "Придумайте пароль", type: "password" }),
  ) === null,
  "russian new password rejected",
);
assert(
  classifyNativeLoginControl(
    control({ label: "Повторите пароль", type: "password" }),
  ) === null,
  "russian repeat password rejected",
);
assert(
  classifyNativeLoginControl(control({ label: "Электронная почта" }))?.token ===
    "email",
  "russian email label",
);
assert(
  classifyNativeLoginControl(control({ label: "Номер телефона" }))?.token === "tel",
  "russian phone label",
);
assert(
  classifyNativeLoginControl(control({ label: "Имя пользователя" }))?.token ===
    "username",
  "russian username label",
);
assert(
  classifyNativeLoginControl(control({ label: "Логин" }))?.token === "username",
  "russian login label",
);
assert(
  classifyNativeLoginControl(control({ label: "Email address" }))?.token === "email",
  "english email label still works",
);
assert(classifyNativeLoginControl(control({ label: "Промокод" })) === null, "unrelated field");

const identifier = classifyNativeLoginControl(
  control({ focused: true, index: 0, label: "Электронная почта" }),
);
const password = classifyNativeLoginControl(
  control({ index: 1, label: "Пароль", type: "password" }),
);
assert(identifier !== null && password !== null, "login form classified");

const loginClaims = [
  { token: "email", value: "ivan@mail.ru" },
  { token: "username", value: "ivan@mail.ru" },
  { token: "current-password", value: "ochen-sekretno" },
];
const fills = selectNativeLoginFills([identifier!, password!], loginClaims);
assert(fills.length === 2, "identifier and password are filled");
assert(fills[0]?.control === identifier, "identifier first");
assert(fills[1]?.value === "ochen-sekretno", "password second");
assert(
  selectNativeLoginFills([{ ...identifier!, focused: false }, password!], loginClaims)
    .length === 0,
  "nothing is filled without a focused control",
);
assert(
  selectNativeLoginFills([identifier!], loginClaims).length === 1,
  "identifier-only step is supported",
);

const login = JSON.stringify({
  kind: "login",
  version: 1,
  origin: "https://www.wildberries.ru",
  identifier: { type: "email", value: "ivan@mail.ru" },
  authentication: { type: "password", password: "ochen-sekretno" },
});
const otpLogin = JSON.stringify({
  kind: "login",
  version: 1,
  origin: "https://www.ozon.ru",
  identifier: { type: "phone", value: "+79001112233" },
  authentication: { type: "sms_otp" },
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
  countryCode: "RU",
});

const bound = vaultClaimValues(
  "login",
  login,
  "https://www.wildberries.ru",
  "credentials",
);
assert(bound.get("current-password") === "ochen-sekretno", "password claim");
assert(bound.get("email") === "ivan@mail.ru", "email claim");
assert(bound.get("username") === "ivan@mail.ru", "username claim");
throws(
  () => vaultClaimValues("login", login, "https://wildbernes.ru", "credentials"),
  "restricted to https://www.wildberries.ru",
  "a login must not leave its origin",
);
const otp = vaultClaimValues("login", otpLogin, "https://www.ozon.ru", "credentials");
assert(otp.get("tel") === "+79001112233", "phone identifier claim");
assert(!otp.has("current-password"), "an OTP login has no password to fill");
throws(
  () => vaultClaimValues("payment", card, "https://www.ozon.ru", "credentials"),
  "not compatible",
  "a card must not answer a login form",
);

const cardValues = vaultClaimValues("payment", card, "https://www.ozon.ru", "payment-card");
assert(cardValues.get("cc-exp") === "04/30", "expiry shorthand");
assert(cardValues.get("cc-exp-month") === "04", "padded month");
assert(!cardValues.has("postal-code"), "no postal code when the card has none");

const addressValues = vaultClaimValues(
  "address",
  address,
  "https://www.ozon.ru",
  "postal-address",
);
assert(addressValues.get("address-level2") === "Москва", "city claim");
assert(addressValues.get("country-name") === "Россия", "russian country name");
assert(!addressValues.has("address-level1"), "no region when it is missing");
assert(!addressValues.has("postal-code"), "no postal code when it is missing");

const cardPayload = buildNativeAutofillPayload(
  "payment",
  [...cardValues].map(([token, value]) => ({ token, value })),
);
assert("card" in cardPayload, "chromium card payload");
assert(cardPayload.card.number === "2200123456789012", "card number passed through");
assert(cardPayload.card.cvc === "123", "cvv passed through");
throws(
  () =>
    buildNativeAutofillPayload("payment", [
      { token: "cc-number", value: "2200123456789012" },
    ]),
  "payment card is incomplete",
  "an incomplete card must not be submitted",
);

const addressPayload = buildNativeAutofillPayload(
  "address",
  [...addressValues].map(([token, value]) => ({ token, value })),
);
assert("address" in addressPayload, "chromium address payload");
const fieldNames = addressPayload.address.fields.map((field) => field.name);
assert(fieldNames.includes("ADDRESS_HOME_CITY"), "city mapped to chromium");
assert(!fieldNames.includes("ADDRESS_HOME_STATE"), "missing region is skipped");
throws(
  () => buildNativeAutofillPayload("address", [{ token: "nonsense", value: "x" }]),
  "address is incomplete",
  "an unmapped address must not be submitted",
);

assert(nativeAutofillTokens.payment.includes("cc-csc"), "card tokens");
assert(nativeAutofillTokens.login.includes("current-password"), "login tokens");
assert(nativeAutofillTokens.address.includes("postal-code"), "address tokens");

console.log("worker ok");
