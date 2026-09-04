import {
  cardBindings,
  normalizePayHost,
  normalizePayHosts,
  PAY_ALIASES,
  payScaffold,
} from "../agent/lib/browser-pay.ts";
import { scaffoldTask } from "../agent/lib/browseruse.ts";
import type { PaymentPayload } from "../convex/lib/vaultPayload.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function throws(fn: () => unknown, msg: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(msg);
}

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
    withoutPay.includes("Если нужна оплата — остановись и дай live-URL."),
    "unchanged behavior without pay",
  );
  assert(
    withoutPay.includes(
      "Доводи дело до конца, если оплата не требуется",
    ),
    "unchanged finish line without pay",
  );
  assert(scaffoldTask(withoutPay) === withoutPay, "idempotent without pay");
}

{
  const syncedWithPay = scaffoldTask(raw, { profileSynced: true, pay: payOpts });
  assert(syncedWithPay.includes("Cloud-профиле"), "synced wording kept");
  assert(
    syncedWithPay.includes(PAY_ALIASES.number),
    "pay block present for synced profile too",
  );
  assert(
    !syncedWithPay.includes("Если нужна оплата — остановись"),
    "synced+pay drops generic pay-stop sentence",
  );
}

console.log("browser-pay-check ok");

// --- subdomain wording (a bare host covers www. and other subdomains) ---
assert(
  payScaffold({ hosts: ["ozon.ru"], holder: "A", account: "B" }).includes("поддомен"),
  "payScaffold tells the agent that subdomains are covered",
);
