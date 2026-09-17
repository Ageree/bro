import {
  cardBindings,
  expandLoginHosts,
  expandPayHosts,
  isAttachCardErrand,
  LOGIN_ALIASES,
  loginBindings,
  loginScaffold,
  normalizePayHost,
  normalizePayHosts,
  PAY_ALIASES,
  PAY_HOST_LIMIT,
  payScaffold,
  registrableDomain,
} from "../agent/lib/browser-pay.ts";
import type { LoginPayload } from "../convex/lib/vaultPayload.ts";
import { scaffoldTask } from "../agent/lib/browseruse.ts";
import type { PaymentPayload } from "../convex/lib/vaultPayload.ts";

import { assert, eq, src, throws } from "./lib/check.ts";

// --- normalizePayHost ---

assert(normalizePayHost("wildberries.ru") === "wildberries.ru", "bare host");
assert(
  normalizePayHost("https://www.wildberries.ru/checkout/pay?x=1") === "wildberries.ru",
  "URL with www and path",
);
assert(normalizePayHost("WILDBERRIES.RU") === "wildberries.ru", "uppercase lowered");
assert(normalizePayHost("www.ozon.ru") === "ozon.ru", "www stripped from bare host");
assert(normalizePayHost("localhost") === undefined, "localhost has no dot, rejected");
assert(normalizePayHost("wildberries") === undefined, "no-dot host rejected");
assert(normalizePayHost("https://") === undefined, "empty URL rejected");
assert(normalizePayHost("") === undefined, "empty string rejected");
assert(normalizePayHost("   ") === undefined, "blank string rejected");
assert(normalizePayHost("127.0.0.1") === undefined, "loopback rejected");
assert(normalizePayHost("169.254.169.254") === undefined, "link-local rejected");
assert(normalizePayHost("10.1.2.3") === undefined, "private IPv4 rejected");
assert(normalizePayHost("192.168.1.1") === undefined, "private subnet rejected");
assert(normalizePayHost("::1") === undefined, "IPv6 loopback rejected");
assert(normalizePayHost("www.ozon.ru") === "ozon.ru", "www.ozon.ru normalizes to ozon.ru");

// --- normalizePayHosts ---

assert(
  JSON.stringify(normalizePayHosts(["Wildberries.ru", "wildberries.ru", "www.wildberries.ru"])) ===
    JSON.stringify(["wildberries.ru"]),
  "dedupe across case/www variants",
);
assert(
  JSON.stringify(normalizePayHosts(["ozon.ru", "bad host", "wildberries.ru"])) ===
    JSON.stringify(["ozon.ru", "wildberries.ru"]),
  "drops invalid entries, keeps order",
);
{
  const many = Array.from({ length: 15 }, (_, i) => `shop${i}.ru`);
  assert(normalizePayHosts(many).length === 10, "capped at 10");
  assert(normalizePayHosts(many)[0] === "shop0.ru", "cap keeps original order");
}

// --- cardBindings ---

const card: PaymentPayload = {
  kind: "payment-card",
  version: 1,
  cardholderName: "IVAN PETROV",
  number: "4111111111111111",
  expirationMonth: 3,
  expirationYear: 2027,
  securityCode: "123",
  billingPostalCode: undefined,
};

{
  const hosts = ["wildberries.ru"];
  const bindings = cardBindings(card, hosts);
  assert(bindings.length === 6, "six bindings");
  const aliases = bindings.map((b) => b.alias).sort();
  assert(
    JSON.stringify(aliases) ===
      JSON.stringify(Object.values(PAY_ALIASES).sort()),
    "bindings cover all aliases",
  );
  for (const b of bindings) {
    assert(b.source.type === "inline", "source type inline");
    assert(
      JSON.stringify(b.allowedDomains) === JSON.stringify(hosts),
      "allowedDomains matches hosts",
    );
  }
  const expiry = bindings.find((b) => b.alias === PAY_ALIASES.expiry);
  assert(expiry?.source.value === "03/27", "expiry padded MM/YY");
  const month = bindings.find((b) => b.alias === PAY_ALIASES.expMonth);
  assert(month?.source.value === "03", "month padded");
  const year = bindings.find((b) => b.alias === PAY_ALIASES.expYear);
  assert(year?.source.value === "27", "year is two digits");
  const yearFull = bindings.find((b) => b.alias === PAY_ALIASES.expYearFull);
  assert(yearFull?.source.value === "2027", "full year is four digits");
  const number = bindings.find((b) => b.alias === PAY_ALIASES.number);
  assert(number?.source.value === "4111111111111111", "number as-is");
  const cvc = bindings.find((b) => b.alias === PAY_ALIASES.cvc);
  assert(cvc?.source.value === "123", "cvc as-is");
}

throws(() => cardBindings(card, []), "cardBindings throws on empty hosts");

// --- payScaffold ---

{
  const text = payScaffold({
    hosts: ["wildberries.ru", "pay.wildberries.ru"],
    holder: "IVAN PETROV",
    account: "Visa · •••• 1111",
    maxRub: 5000,
  });
  for (const alias of Object.values(PAY_ALIASES)) {
    assert(text.includes(alias), `payScaffold mentions ${alias}`);
  }
  assert(text.includes("wildberries.ru"), "payScaffold mentions host");
  assert(text.includes("pay.wildberries.ru"), "payScaffold mentions second host");
  assert(text.includes("IVAN PETROV"), "payScaffold mentions holder");
  assert(text.includes("Visa · •••• 1111"), "payScaffold mentions account");
  assert(text.includes("5000"), "payScaffold mentions maxRub");
}
{
  const noLimit = payScaffold({
    hosts: ["wildberries.ru"],
    holder: "IVAN PETROV",
    account: "Visa · •••• 1111",
  });
  assert(!noLimit.includes("больше"), "no maxRub line when maxRub unset");
}

// --- scaffoldTask ---

const raw = "купи кроссовки 42 размера на wildberries.ru";
const payOpts = {
  hosts: ["wildberries.ru"],
  holder: "IVAN PETROV",
  account: "Visa · •••· 1111",
  maxRub: 5000,
};

{
  const withPay = scaffoldTask(raw, { pay: payOpts });
  assert(withPay.startsWith("[bro-errand]"), "starts with marker");
  assert(
    withPay.includes(PAY_ALIASES.number) && withPay.includes(PAY_ALIASES.cvc),
    "pay scaffold block present",
  );
  assert(
    !withPay.includes("Если нужна оплата — остановись"),
    "no generic pay-stop sentence when paying",
  );
  assert(
    withPay.includes("Доводи дело до конца, включая оплату"),
    "finish line mentions paying with the card",
  );
  assert(scaffoldTask(withPay, { pay: payOpts }) === withPay, "idempotent with pay");
  assert(
    scaffoldTask(withPay) === withPay,
    "idempotent even if pay omitted on second call",
  );
}

{
  const withoutPay = scaffoldTask(raw);
  assert(
    withoutPay.includes("НУЖНО: payment"),
    "unchanged behavior without pay — structured outcome, no live-URL",
  );
  assert(
    withoutPay.includes("Доводи дело до конца"),
    "finish line without pay still completes the errand",
  );
  // The finish line no longer names a taxi's «Заказать» button (that worked
  // example was hardcoded into a sentence that applies to every errand) — it
  // still has to drive the run past the form to the final confirmation.
  assert(
    withoutPay.includes("жми финальную кнопку подтверждения"),
    "default errand is driven to the final confirmation button",
  );
  assert(scaffoldTask(withoutPay) === withoutPay, "idempotent without pay");
}

{
  const syncedWithPay = scaffoldTask(raw, { profileSynced: true, pay: payOpts });
  // Contract, not wording: a synced profile is told its cookies may already be
  // there AND that cookies are not proof of a login, and it still signs in
  // itself rather than parking on a guest screen.
  // The cookie note and the «решай сам: баннеры закрывай… входи или
  // регистрируйся» line are gone from every scaffold (errand-brief.ts): both
  // were generic advice, ~250 characters of it, on every single run. The
  // autonomy they granted survives as one short line.
  assert(!/куки прошлой сессии/.test(syncedWithPay), "the cookie note is gone");
  assert(!syncedWithPay.includes("баннеры закрывай"), "banner advice is gone");
  assert(syncedWithPay.includes("Решай сам"), "the autonomy licence survives");
  assert(
    syncedWithPay.includes(PAY_ALIASES.number),
    "pay block present for synced profile too",
  );
  assert(
    !syncedWithPay.includes("Если нужна оплата — остановись"),
    "synced+pay drops generic pay-stop sentence",
  );
}

const loginPassword = ["bro", "test", "fixture"].join("-");
const login: LoginPayload = {
  kind: "login",
  version: 1,
  origin: "https://taxi.yandex.ru",
  identifier: { type: "email", value: "sava@mail.ru" },
  authentication: { type: "password", password: loginPassword },
};
{
  const bindings = loginBindings(login, ["taxi.yandex.ru", "yandex.ru"]);
  assert(bindings.length === 2, "login + password bindings");
  assert(bindings[0]?.alias === LOGIN_ALIASES.login, "login alias");
  assert(bindings[1]?.alias === LOGIN_ALIASES.password, "password alias");
  assert(bindings[0]?.source.value === "sava@mail.ru", "identifier bound");
  assert(bindings[1]?.source.value === loginPassword, "password bound");
  assert(
    JSON.stringify(bindings[0]?.allowedDomains) ===
      JSON.stringify(["taxi.yandex.ru", "yandex.ru"]),
    "login domains",
  );
}
throws(
  () =>
    loginBindings(
      { ...login, authentication: { type: "sms_otp" } },
      ["ozon.ru"],
    ),
  "otp login cannot be bound",
);
throws(() => loginBindings(login, []), "loginBindings throws on empty hosts");

{
  const text = loginScaffold();
  assert(text.includes(LOGIN_ALIASES.login), "login scaffold names login alias");
  assert(text.includes(LOGIN_ALIASES.password), "login scaffold names password alias");
  assert(!text.includes(loginPassword), "login scaffold has no secret");
  assert(
    scaffoldTask("зайди на ozon", { login: true }).includes(LOGIN_ALIASES.password),
    "errand scaffold includes vault login block",
  );
  assert(
    !scaffoldTask("зайди на ozon", { login: true }).includes(
      "Если пароля в задаче нет и сайт просит логин",
    ),
    "vault login does not fall back to asking the human",
  );
}

// ---------------------------------------------------------------------------
// registrableDomain / expandPayHosts — the Yandex Taxi root cause: the card
// form is never on taxi.yandex.ru, it is on pay./trust./passport.yandex.ru.
// Browser Use v4: "A host covers its subdomains. Bare hostnames only."
// (docs.browser-use.com/cloud/api-v4/runs/create-run.md, SecretBinding), so
// binding only the merchant host leaves the real card field unbindable.
// ---------------------------------------------------------------------------

eq(registrableDomain("taxi.yandex.ru"), "yandex.ru", "sibling-covering root domain");
eq(registrableDomain("ozon.ru"), "ozon.ru", "an apex host is its own root");
eq(registrableDomain("https://www.wildberries.ru/x"), "wildberries.ru", "URL + www");
eq(registrableDomain("a.b.c.yandex.ru"), "yandex.ru", "deep subdomain");
eq(registrableDomain("127.0.0.1"), undefined, "an IP never yields a root");
eq(registrableDomain("localhost"), undefined, "localhost never yields a root");
// Shared hosting: every customer is a subdomain, so widening would hand the
// card to somebody else's shop.
eq(
  registrableDomain("shop.myshopify.com"),
  "shop.myshopify.com",
  "a shared-hosting host is never widened to its provider",
);
eq(registrableDomain("site.vercel.app"), "site.vercel.app", "vercel.app is a public suffix");
eq(registrableDomain("shop.com.ru"), "shop.com.ru", "com.ru is a public suffix");

{
  const hosts = expandPayHosts(["taxi.yandex.ru"]);
  assert(hosts.includes("yandex.ru"), "the taxi errand binds the Yandex root domain");
  assert(
    !hosts.includes("taxi.yandex.ru"),
    "the narrower merchant host is dropped once its root covers it",
  );
  assert(hosts.length <= PAY_HOST_LIMIT, "never over the API's 10-domain cap");
  assert(hosts.includes("yoomoney.ru"), "Yandex's own wallet host is bound too");
  for (const h of hosts) {
    assert(normalizePayHost(h) === h, `${h} is a clean bare host`);
  }
}
{
  // Structural, not a Yandex special case: any merchant gets the common
  // Russian processors its checkout may hand over to.
  const hosts = expandPayHosts(["ozon.ru"]);
  assert(hosts[0] === "ozon.ru", "the merchant host stays first");
  assert(hosts.includes("cloudpayments.ru"), "generic processor bound");
  assert(hosts.includes("yookassa.ru"), "generic processor bound");
  assert(hosts.length <= PAY_HOST_LIMIT, "cap respected");
}
{
  // Never a bank's login domain — only its acquiring/card-form host.
  const hosts = expandPayHosts(["ozon.ru"]);
  assert(!hosts.includes("tinkoff.ru"), "the bare bank domain is never bound");
  assert(!hosts.includes("sberbank.ru"), "the bare bank domain is never bound");
  assert(hosts.includes("securepay.tinkoff.ru"), "the acquiring host is bound instead");
}
{
  // Private / IP / junk hosts are refused before anything is derived from them.
  const hosts = expandPayHosts(["127.0.0.1", "localhost", "not a host", "taxi.yandex.ru"]);
  assert(hosts.includes("yandex.ru"), "the one valid host still expands");
  for (const bad of ["127.0.0.1", "localhost", "not a host"]) {
    assert(!hosts.includes(bad), `${bad} never reaches allowedDomains`);
  }
  assert(expandPayHosts(["127.0.0.1"]).length === 0, "only private hosts → nothing to bind");
  assert(expandPayHosts([]).length === 0, "no hosts → nothing to bind");
}
{
  // Cap: prioritise, never blindly truncate. Ten caller hosts fill the ten
  // slots (nothing lower-priority displaces a host the caller named).
  const many = Array.from({ length: 14 }, (_, i) => `shop${i}.ru`);
  const hosts = expandPayHosts(many);
  eq(hosts.length, PAY_HOST_LIMIT, "capped at the API maximum");
  eq(hosts[0], "shop0.ru", "caller order preserved");
  assert(!hosts.includes("shop10.ru"), "the overflow tail is what gets dropped");
}
{
  // A caller that names many merchant subdomains still gets their roots in:
  // roots are interleaved right after their own host, not appended last.
  const hosts = expandPayHosts(
    Array.from({ length: 10 }, (_, i) => `sub${i}.merchant${i}.ru`),
  );
  assert(hosts.includes("merchant0.ru"), "the first host's root survives the cap");
  assert(hosts.includes("merchant4.ru"), "a middle host's root survives the cap too");
}
{
  // Cross-TLD sibling: yandex.com's card form lives on yandex.ru.
  const hosts = expandPayHosts(["taxi.yandex.com"]);
  assert(hosts.includes("yandex.com"), "own root bound");
  assert(hosts.includes("yandex.ru"), "curated cross-TLD sibling bound");
}

// expandLoginHosts: the site's own family only — a password must never become
// typeable on a payment processor.
{
  const hosts = expandLoginHosts(["https://taxi.yandex.ru/"]);
  assert(hosts.includes("yandex.ru"), "a login covers passport.yandex.ru via the root");
  for (const processor of ["yookassa.ru", "cloudpayments.ru", "yoomoney.ru"]) {
    assert(!hosts.includes(processor), `login never bound to ${processor}`);
  }
}

// The bindings actually carry the widened domains.
{
  const hosts = expandPayHosts(["taxi.yandex.ru"]);
  const bindings = cardBindings(card, hosts);
  assert(bindings.length === 6, "still six card bindings");
  for (const b of bindings) {
    assert(
      b.allowedDomains.includes("yandex.ru"),
      "every card binding is allowed on the Yandex root",
    );
    assert(b.allowedDomains.length <= 10, "API cap holds per binding");
  }
}

// ---------------------------------------------------------------------------
// isAttachCardErrand — «привяжи карту» is its own errand shape, not a purchase
// ---------------------------------------------------------------------------

for (const yes of [
  "привяжи карту в яндекс такси",
  "добавь карту в яндекс такси",
  "подключи карту на озоне",
  "сохрани мою карту",
  "карту привяжи, как в приложении",
  "добавь способ оплаты",
  "add a card to yandex taxi",
  "save my credit card",
]) {
  assert(isAttachCardErrand(yes), `attach-card errand: ${yes}`);
}
for (const no of [
  "купи кроссовки на wb",
  "оплати картой из сейфа",
  "вызови такси домой",
  "закажи воду на ozon и оплати картой",
  "",
]) {
  assert(!isAttachCardErrand(no), `not an attach-card errand: ${no}`);
}
assert(!isAttachCardErrand(undefined), "undefined task is not an attach-card errand");

// ---------------------------------------------------------------------------
// payScaffold / scaffoldTask in attach-card mode
// ---------------------------------------------------------------------------

{
  const attachHosts = expandPayHosts(["taxi.yandex.ru"]);
  const text = payScaffold({
    hosts: attachHosts,
    holder: "IVAN PETROV",
    account: "Visa · •••• 1111",
    attachCard: true,
  });
  assert(text.includes("привязать карту"), "names the goal: save the card");
  assert(text.includes("Добавить карту"), "points at the Добавить карту control");
  assert(text.includes("1 ₽"), "warns about the bank's small hold");
  // The iframe tactic hint is gone (see payScaffold): what it was really
  // saying — the card form is on a sibling domain — is enforced by
  // expandPayHosts binding the card there, not by advice in the prompt.
  assert(!text.includes("iframe"), "the iframe tactic hint is gone");
  assert(text.includes("yandex.ru"), "lists the widened domains");
  assert(text.includes("НУЖНО: 3ds"), "3-D Secure has a reachable outcome");
  assert(text.includes("НУЖНО: sms_code"), "bank SMS has a reachable outcome");
  assert(text.includes("НУЖНО: push"), "bank push has a reachable outcome");
  assert(!text.includes("номер заказа"), "an attach-card run must not chase an order number");
  for (const alias of Object.values(PAY_ALIASES)) {
    assert(text.includes(alias), `attach scaffold still names ${alias}`);
  }
  assert(!text.includes("4111111111111111"), "no card value in the prompt");
}
{
  const buy = payScaffold({
    hosts: ["ozon.ru"],
    holder: "IVAN PETROV",
    account: "Visa · •••• 1111",
  });
  assert(buy.includes("номер заказа"), "a paying run still checks the order number");
  assert(!buy.includes("привязать карту"), "a paying run is not an attach-card run");
  assert(!buy.includes("iframe"), "the iframe tactic hint is gone from paying too");
}
{
  const attach = scaffoldTask("привяжи карту в яндекс такси", {
    pay: {
      hosts: expandPayHosts(["taxi.yandex.ru"]),
      holder: "IVAN PETROV",
      account: "Visa · •••• 1111",
      attachCard: true,
    },
  });
  assert(attach.includes(PAY_ALIASES.number), "card aliases bound into the errand");
  assert(
    attach.includes("Ничего не заказывай"),
    "the finish block forbids placing an order",
  );
  assert(
    !attach.includes("Доводи дело до конца, включая оплату"),
    "the paying finish line is replaced, not added to",
  );
  assert(attach.includes("НУЖНО: none|"), "the mandatory outcome block survives");
  for (const label of ["СДЕЛАНО:", "ЗАКАЗ:", "СУММА:", "КОГДА:", "ВАРИАНТЫ:", "НУЖНО:", "ДЕТАЛИ:"]) {
    assert(attach.includes(label), `outcome block keeps ${label}`);
  }
}
{
  // Even with no card bound (nothing in the vault, no resolvable host), an
  // attach-card errand must not be driven like a taxi order.
  const bare = scaffoldTask("привяжи карту в яндекс такси");
  assert(bare.includes("Ничего не заказывай"), "attach shape holds without pay");
  assert(
    !bare.includes("нажми «Заказать»"),
    "an attach-card errand never gets the order-the-taxi finish line",
  );
  assert(bare.includes("НУЖНО: payment"), "it still asks for the card via the outcome block");
}
{
  const buying = scaffoldTask("купи кроссовки 42 размера на wildberries.ru");
  assert(
    buying.includes("жми финальную кнопку подтверждения"),
    "an ordinary errand keeps its finish line",
  );
}

// ---------------------------------------------------------------------------
// browser_task wiring for the card flow (source-level: needs a live Cloud
// session to exercise end to end)
// ---------------------------------------------------------------------------
{
  const taskSrc = src("agent/tools/browser_task.ts");
  assert(
    /payHosts = expandPayHosts\(rawHosts\)/.test(taskSrc),
    "a paid start binds the WIDENED host set, not the raw merchant hostnames",
  );
  assert(
    taskSrc.includes("contPayHosts = expandPayHosts(pay.hosts)"),
    "a continuation binds the widened host set too",
  );
  assert(
    /loginPagesFor\(task, payHostsBase, startPage\)/.test(taskSrc),
    "the vault-login lookup uses the caller's own hosts, not the payment processors",
  );
  assert(
    taskSrc.includes("const attachCard = isAttachCardErrand(task);"),
    "browser_task recognises an attach-card errand without `pay`",
  );
  assert(
    /if \(pay \|\| attachCard\) \{/.test(taskSrc),
    "an attach-card errand resolves a vault card just like a paid one",
  );
  assert(
    /if \(payHosts && payItem\) \{/.test(taskSrc),
    "card bindings are attached whenever hosts and a card exist, `pay` or not",
  );
  assert(
    taskSrc.includes("(pay || attachCard) && rawAction === \"reuse\""),
    "an attach-card repeat starts a fresh run — bindings are run-scoped",
  );
  // The attach-card guard now lives in the gate both completion paths share
  // (convex/lib/orderRecordPolicy.ts), so a background purchase recorded from
  // convex/browserFollow.ts obeys exactly the same rule.
  assert(
    src("convex/lib/orderRecordPolicy.ts").includes(
      "if (isAttachCardErrand(task) && !buy) return null;",
    ),
    "attaching a card never records an order (the bank's 1 ₽ hold is not a purchase)",
  );
  assert(
    taskSrc.includes("orderRowFromRun({"),
    "browser_task records through that shared gate",
  );
}

console.log("browser-pay-check ok");

// --- subdomain wording (a bare host covers www. and other subdomains) ---
assert(
  payScaffold({ hosts: ["ozon.ru"], holder: "A", account: "B" }).includes("поддомен"),
  "payScaffold tells the agent that subdomains are covered",
);

// --- A3 item 2: browser_task persists paying/hosts so a later settle() (poll,
// reuse, inject) can still gate maybeRecordOrder correctly, not just the
// synchronous call that started the paid run ---
{
  const taskSrc = src("agent/tools/browser_task.ts");
  assert(
    /browserPaying: Boolean\(payOpts\)/.test(taskSrc),
    "a fresh start persists whether it is a paid run",
  );
  assert(
    /browserPayHosts: payOpts\?\.hosts \?\? \[\]/.test(taskSrc),
    "a fresh start persists the paid hosts (or clears them for a non-paid run)",
  );
}
