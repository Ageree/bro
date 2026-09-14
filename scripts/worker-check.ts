import {
  buildNativeAutofillPayload,
  nativeAutofillTokens,
  originAllows,
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
import {
  checkPlaywrightCode,
  forgetVaultFilled,
  markVaultFilled,
  playwrightCodeRisk,
} from "../agent/subagents/worker/lib/code-guard.ts";
import {
  BROWSER_TIMEOUT_FLOOR_SECONDS,
  BROWSER_TIMEOUT_LONG_LIVED_SECONDS,
  defaultBrowserTimeoutSeconds,
  looksLikeLoginOrCheckoutUrl,
} from "../agent/subagents/worker/lib/timeout-policy.ts";
import { scrubSecrets } from "../convex/lib/secretScrub.ts";
import {
  isStaleBrowserSession,
  STALE_BROWSER_SESSION_MS,
} from "../convex/lib/browserSessionGc.ts";

import { assert, src, throws, withEnv } from "./lib/check.ts";

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

withEnv({ KERNEL_API_KEY: undefined }, () => {
  assert(!kernelEnabled(), "kernel disabled without a key");
  throws(() => kernel(), "kernel must fail loudly without a key", "KERNEL_API_KEY");
});

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
  classifyNativeLoginControl(control({ autocomplete: "new-password" }), {
    allowSignupPassword: true,
  })?.token === "current-password",
  "signup path fills new-password",
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
  classifyNativeLoginControl(
    control({ label: "Придумайте пароль", type: "password" }),
    { allowSignupPassword: true },
  )?.token === "current-password",
  "signup path fills russian new password",
);
assert(
  classifyNativeLoginControl(
    control({ label: "Повторите пароль", type: "password" }),
    { allowSignupPassword: true },
  )?.token === "current-password",
  "signup path fills russian repeat password",
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
const createPassword = classifyNativeLoginControl(
  control({
    focused: true,
    formIndex: 0,
    index: 2,
    label: "Придумайте пароль",
    type: "password",
  }),
  { allowSignupPassword: true },
);
const confirmPassword = classifyNativeLoginControl(
  control({
    formIndex: 0,
    index: 3,
    label: "Повторите пароль",
    type: "password",
  }),
  { allowSignupPassword: true },
);
assert(
  createPassword !== null && confirmPassword !== null,
  "signup passwords classified",
);
const signupFills = selectNativeLoginFills(
  [createPassword!, confirmPassword!],
  loginClaims,
);
assert(signupFills.length === 2, "signup fills password and confirm");
assert(
  signupFills.every((fill) => fill.value === "ochen-sekretno"),
  "signup repeats the same password",
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

// Test originAllows
assert(originAllows("https://www.ozon.ru", "https://ozon.ru"), "www↔bare both ways (saved with www)");
assert(originAllows("https://ozon.ru", "https://www.ozon.ru"), "www↔bare both ways (saved bare)");
assert(originAllows("https://ozon.ru", "https://auth.ozon.ru"), "subdomain under parent");
assert(!originAllows("https://auth.ozon.ru", "https://ozon.ru"), "parent under saved subdomain denied");
assert(!originAllows("https://ozon.ru", "https://evil-ozon.ru"), "different domain denied");
assert(!originAllows("http://ozon.ru", "https://ozon.ru"), "protocol mismatch denied");

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
  "a login must not leave its origin",
  "restricted to https://www.wildberries.ru",
);
const otp = vaultClaimValues("login", otpLogin, "https://www.ozon.ru", "credentials");
assert(otp.get("tel") === "+79001112233", "phone identifier claim");
assert(!otp.has("current-password"), "an OTP login has no password to fill");
throws(
  () => vaultClaimValues("payment", card, "https://www.ozon.ru", "credentials"),
  "a card must not answer a login form",
  "not compatible",
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
  "an incomplete card must not be submitted",
  "payment card is incomplete",
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
  "an unmapped address must not be submitted",
  "address is incomplete",
);

assert(nativeAutofillTokens.payment.includes("cc-csc"), "card tokens");
assert(nativeAutofillTokens.login.includes("current-password"), "login tokens");
assert(nativeAutofillTokens.address.includes("postal-code"), "address tokens");

const workerInstr = src("agent/subagents/worker/instructions.md");
assert(
  workerInstr.includes("If the assignment includes a username or password"),
  "worker types a supplied password",
);
assert(
  workerInstr.includes("Needs profile sync"),
  "worker still falls back to a login link",
);

// --- Secret read-back guard (execute_playwright_code) ---------------------

assert(
  playwrightCodeRisk("return await page.title();") === null,
  "reading the page title is not risky",
);
assert(
  playwrightCodeRisk("return await page.$eval('input', el => el.value);") !== null,
  "reading .value is risky",
);
assert(
  playwrightCodeRisk("return await page.locator('#a').inputValue();") !== null,
  "inputValue() is risky",
);
assert(
  playwrightCodeRisk("return await context.cookies();") !== null,
  "context.cookies() is risky",
);
assert(
  playwrightCodeRisk("return document.cookie;") !== null,
  "document.cookie is risky",
);
assert(
  playwrightCodeRisk("return el.dataset.vaultSecret;") !== null,
  "reading the vaultSecret marker is risky",
);
assert(
  playwrightCodeRisk("return document.querySelector('[data-vault-secret]');") !==
    null,
  "querying data-vault-secret is risky",
);
assert(
  playwrightCodeRisk("return window.localStorage.getItem('x');") !== null,
  "localStorage is risky",
);
assert(
  playwrightCodeRisk("return window.sessionStorage.getItem('x');") !== null,
  "sessionStorage is risky",
);
assert(
  playwrightCodeRisk("return await page.evaluate(() => document.title);") ===
    null,
  "an evaluate() that never touches value is safe",
);
assert(
  playwrightCodeRisk(
    "return await page.evaluate(el => el.value, handle);",
  ) !== null,
  "an evaluate() reading value is risky",
);
assert(
  playwrightCodeRisk("await page.click('#submit'); return { ok: true };") ===
    null,
  "a plain click is safe",
);

const SESSION = "sess-guard-1";
const RISKY_CODE = "return await page.$eval('input', el => el.value);";
forgetVaultFilled(SESSION);
const beforeFill = checkPlaywrightCode(RISKY_CODE, SESSION);
assert(beforeFill.blocked === false, "risky code only warns before a vault fill");
assert(!!beforeFill.warning, "the warning is carried even though the call is allowed");
markVaultFilled(SESSION);
const afterFill = checkPlaywrightCode(RISKY_CODE, SESSION);
assert(afterFill.blocked === true, "the same code is refused after a vault fill");
assert(
  /после ввода из сейфа/.test(afterFill.reason),
  "the refusal reason is in Russian and names the vault fill",
);
const safeAfterFill = checkPlaywrightCode("return await page.title();", SESSION);
assert(safeAfterFill.blocked === false, "safe code still runs after a vault fill");
forgetVaultFilled(SESSION);

// --- Redaction (scrubSecrets, reused from convex/lib/secretScrub.ts) ------

assert(
  scrubSecrets("card 4111 1111 1111 1111 expires 04/30") === "card [card] expires 04/30",
  "a spaced PAN is redacted",
);
assert(
  scrubSecrets("cvc: 123") === "cvc: [cvv]",
  "a labeled CVV is redacted but the label survives",
);
assert(
  scrubSecrets("password: hunter2ochenSekretno") === "password: [password]",
  "a labeled password is redacted but the label survives",
);
assert(
  scrubSecrets("итого 1990 руб, 2 шт") === "итого 1990 руб, 2 шт",
  "an ordinary price/quantity line is left alone",
);
assert(
  scrubSecrets("пароль: hunter2") === "пароль: [password]",
  "a Cyrillic labeled password is redacted (unicode-aware \\b)",
);
assert(
  scrubSecrets("password=Qwe123!") === "password=[password]",
  "an ASCII label with = separator is redacted",
);
assert(
  scrubSecrets("пароль не подошёл") === "пароль не подошёл",
  "prose using the word пароль without a separator is left alone",
);
assert(
  scrubSecrets("Ваш код 482913") === "Ваш код 482913",
  "an OTP code sentence is left alone",
);

const execCode = src("agent/subagents/worker/tools/execute_playwright_code.ts");
assert(
  execCode.includes("checkPlaywrightCode"),
  "execute_playwright_code enforces the guard",
);
assert(
  execCode.includes("scrubSecrets"),
  "execute_playwright_code redacts result/stderr/stdout before returning them",
);
const fillFromVault = src("agent/subagents/worker/tools/fill_from_vault.ts");
assert(
  fillFromVault.includes("markVaultFilled"),
  "fill_from_vault flips the per-session guard flag",
);

// --- Kernel timeout defaults -----------------------------------------------

assert(BROWSER_TIMEOUT_FLOOR_SECONDS === 15 * 60, "15 minute floor is unchanged");
assert(
  BROWSER_TIMEOUT_LONG_LIVED_SECONDS === 45 * 60,
  "long-lived default is 45 minutes",
);
assert(
  defaultBrowserTimeoutSeconds({}) === BROWSER_TIMEOUT_FLOOR_SECONDS,
  "a plain read-only assignment keeps the 15 minute floor",
);
assert(
  defaultBrowserTimeoutSeconds({ saveChanges: true }) ===
    BROWSER_TIMEOUT_LONG_LIVED_SECONDS,
  "save_changes: true gets the 45 minute default",
);
assert(
  defaultBrowserTimeoutSeconds({ longLived: true }) ===
    BROWSER_TIMEOUT_LONG_LIVED_SECONDS,
  "long_lived: true gets the 45 minute default",
);
assert(
  defaultBrowserTimeoutSeconds({
    startUrl: "https://www.wildberries.ru/security/login",
  }) === BROWSER_TIMEOUT_LONG_LIVED_SECONDS,
  "a login-looking start_url gets the 45 minute default",
);
assert(
  defaultBrowserTimeoutSeconds({
    startUrl: "https://www.tinkoff.ru/checkout/confirm",
  }) === BROWSER_TIMEOUT_LONG_LIVED_SECONDS,
  "a checkout-looking start_url gets the 45 minute default",
);
assert(
  defaultBrowserTimeoutSeconds({
    startUrl: "https://www.wildberries.ru/catalog/12345",
  }) === BROWSER_TIMEOUT_FLOOR_SECONDS,
  "an ordinary product page keeps the 15 minute floor",
);
assert(
  !looksLikeLoginOrCheckoutUrl("not a url"),
  "an unparsable start_url never throws",
);

const manageBrowsers = src("agent/subagents/worker/tools/manage_browsers.ts");
assert(
  manageBrowsers.includes("long_lived"),
  "manage_browsers accepts long_lived",
);
assert(
  manageBrowsers.includes("defaultBrowserTimeoutSeconds"),
  "manage_browsers create uses the shared timeout default",
);

// --- Worker output schema (liveViewUrl / needs) ----------------------------

const workerAgent = src("agent/subagents/worker/agent.ts");
assert(workerAgent.includes("liveViewUrl"), "worker output carries liveViewUrl");
assert(
  workerAgent.includes("needs:") &&
    workerAgent.includes('"otp"') &&
    workerAgent.includes('"3ds"') &&
    workerAgent.includes('"profile_sync"'),
  "worker output carries a needs enum including otp, 3ds, and profile_sync",
);
assert(workerInstr.includes("liveViewUrl"), "worker instructions mention liveViewUrl");
assert(
  workerInstr.includes("long_lived"),
  "worker instructions tell the model to pass long_lived for login/OTP/checkout",
);
assert(
  workerInstr.includes("Cloud run's own live-view") ||
    workerInstr.includes("Cloud run's own `liveViewUrl`"),
  "worker instructions route a Cloud-tab 3DS challenge back to the Cloud live-view",
);
const skill = src("agent/subagents/worker/skills/browser-execution/SKILL.md");
assert(skill.includes("long_lived"), "skill tells the model about long_lived");
assert(skill.includes("liveViewUrl"), "skill tells the model to fill liveViewUrl");

// --- Kernel browser GC (stale session predicate) ---------------------------

assert(STALE_BROWSER_SESSION_MS === 3 * 60 * 60 * 1000, "stale threshold is 3h");
const now = Date.UTC(2026, 8, 6, 12);
assert(
  !isStaleBrowserSession({ createdAt: now - 60_000 }, now),
  "a fresh row is not stale",
);
assert(
  !isStaleBrowserSession({ createdAt: now - STALE_BROWSER_SESSION_MS }, now),
  "exactly at the threshold is not yet stale",
);
assert(
  isStaleBrowserSession({ createdAt: now - STALE_BROWSER_SESSION_MS - 1 }, now),
  "just past the threshold is stale",
);

const browsersSrc = src("convex/browsers.ts");
assert(browsersSrc.includes("sweepStale"), "browsers.ts exposes the GC mutation");
assert(!browsersSrc.includes('"use node"'), "browsers.ts stays free of use node");
const browsersGcSrc = src("convex/browsersGc.ts");
assert(browsersGcSrc.includes('"use node"'), "browsersGc.ts runs in the node runtime");
assert(
  browsersGcSrc.includes("KERNEL_API_KEY"),
  "browsersGc.ts only calls Kernel when this deployment has a key",
);
const cronsSrc = src("convex/crons.ts");
assert(
  cronsSrc.includes("internal.browsersGc.sweep"),
  "crons.ts schedules the browser GC sweep",
);

console.log("worker ok");
