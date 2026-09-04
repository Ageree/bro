# Оплата через Link (Stripe) — исследование

Повод: твит @browser_use «Browser Use × @link: web agents can now make
purchases with your credit card». Вопрос: можно ли дать пользователям Bro
такую же «подключил карту один раз — агент платит» схему.

## Вердикт

**Link для Bro сейчас не подходит.** Два жёстких ограничения из первоисточников:

1. «Agent payments are available to US consumers. The sellers your customers
   buy from can be outside the US.» — только потребители США
   (docs.stripe.com/agentic-commerce/link-cli/use-link-wallet-pay-online).
   Аудитория Bro — русскоязычные, значительная часть в России; Stripe в
   России не работает вовсе. Пользователи за рубежом подошли бы только с
   американским Link-аккаунтом и американским способом оплаты.
2. Хостовому агенту нужен confidential OAuth client, который выдаётся через
   «Contact Stripe sales», не self-serve
   (docs.stripe.com/agentic-commerce/link-cli/oauth).

Прочие факты, если ситуация изменится (глобальный rollout обещан, даты нет):

- Поток: OAuth (`https://login.link.com/auth`, scope `payment_methods.agentic`,
  PKCE) → `spend-request create` (amount, context ≥100 символов, merchant) →
  `approval_url`, человек подтверждает в приложении/на app.link.com за
  10 минут → поллинг `spend-request retrieve --include card --output-file` →
  одноразовая виртуальная карта (PAN/CVC/expiry/billing), живёт 12 часов,
  работает на любом сайте, принимающем карты.
- Лимиты на интеграцию: $500 на запрос и в день, $20 000 в месяц.
- Пакет `@stripe/link-cli` (npm), SDK для TypeScript не опубликован.
- Browser Use Cloud подключает Link через свой дашборд («Integrations» +
  «Pay with Link» на задаче). В OpenAPI v4 (`/runs`) параметра для Link
  нет — через API это не пробрасывается.

## Альтернативы (сентябрь 2026)

Ни один «кошелёк для агентов» не обслуживает держателей карт в России:
Stripe Issuing, PayPal, Coinbase x402 — прямые санкционные ограничения;
Visa Intelligent Commerce и Mastercard Agent Pay — токены только для
подключённых мерчантов и через банки-эмитенты; Lithic — США. Стейблкоин-
кошельки (Payman, Skyfire) не решают задачу «оплатить на Wildberries/Ozon».

## Что реально упрощает оплату уже сейчас

Bro уже умеет платить сохранённой картой, но только через `worker`
(Kernel + CDP-автофилл). В OpenAPI v4 Browser Use нашёлся `secretBindings`
на `POST /runs`:

```json
{
  "secretBindings": [
    {
      "alias": "card_number",
      "source": { "type": "inline", "value": "…" },
      "allowedDomains": ["wildberries.ru"]
    }
  ]
}
```

Описание из спеки: «The value never reaches the agent. It is encrypted at
rest, kept out of the worker payload, and typed straight into the focused
field by the server when the agent asks for the alias by name — and only
while the page it is typing into is on one of `allowedDomains`. Run-scoped».

Это даёт для дефолтного `browser_task` ту же модель, что Link даёт
Browser Use: агент видит только алиасы, сервер печатает секрет сам, домен
ограничен. Реализовано в этой же ветке (`agent/lib/browser-pay.ts`, `browser_task` с `pay`, проверка `npm run pay:check`):

1. `browser_task` получает опциональный `pay: { hosts, maxRub?, vaultHandle? }`.
2. Перед стартом run Bro расшифровывает карту из сейфа (`readForAgent`) и
   передаёт шесть binding'ов — `card_number`, `card_expiry` (ММ/ГГ),
   `card_exp_month`, `card_exp_year`, `card_exp_year_full`, `card_cvc` — с `allowedDomains: hosts`.
3. Подтверждение человека остаётся как сейчас (магазин, товар, количество,
   сумма) — до вызова с `pay`.
4. В скаффолде задачи: «карта уже подключена под алиасами …, введи их в
   форму оплаты, 3-D Secure — остановись и дай live-URL».

Открытый вопрос: точная формулировка, которой cloud-агент просит сервер
ввести алиас, в документации не зафиксирована («use the secret <alias>» в
примере с 1Password). Проверить на первом реальном run с тестовой картой.
