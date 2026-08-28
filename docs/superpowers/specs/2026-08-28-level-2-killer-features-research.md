# Bro Level 2 — киллер-фичи и moonshots (research)

_Date: 2026-08-28. Источники: Exa + официальные доки + параллельные субагенты._
_Не реализация. Решение: что строить, в каком порядке, на чём не строить._

Текущий стек, на который ложится всё ниже: Convex wakeups/jobs, Inkbox iMessage
P2P, Composio (Gmail/Calendar), Browser Use, память = плоские строки ≤280,
`waitingFor: human | email | browser`, биллинг ЮKassa.

---

## Рекомендованная очередь

| # | Тема | Вердикт для Bro сейчас | Почему |
|---|---|---|---|
| 1 | **Коммерция: карточка «Да/Нет»** | **Строить сразу** | Уже есть `job_wait(human)` + текст iMessage. Нулевой новый вендор. Меняет ощущение продукта. |
| 2 | **Память 2.0 (Convex vector + консолидация)** | **Строить сразу** | Без новых рантаймов. Режет ~6K токенов на ход. «Сменил адрес в марте» — это схема, не Mem0. |
| 3 | **Сторожа 2.0 (Composio triggers)** | **Строить сразу** | Убивает пустые ходы агента. Gmail/Calendar — не мгновенно (~1–15 мин), но **бесплатно по токенам**. |
| 4 | **Recipes** | **Следующий продукт** | Вирусная петля без приложения. Poke доказал механику. |
| 5 | **Звонки (Voximplant / Zvonok, не Retell/Vapi)** | **После юрлица + маркировки** | Фича-магия для RU, но Retell **блокирует RU навсегда**. Нужен RU-оператор. |
| 6 | **Family lite** | **После Recipes** | LTV без CAC, но приватность опасна. Сначала общие сторожа, не общая память. |
| 7 | **EN-рынок** | **Параллельная подготовка** | Стек переносим. Stripe + EN-промпты + Retell уже имеют смысл **там**. |
| 8 | **RCS** | **Не для RU-2026** | MTS/Beeline не дают Apple RCS. Карусели — US/UK exit. |

---

## 5. Bro звонит по телефону

### Что хотели

`phone_call` тул → job `waitingFor: "call"` → результат первым iMessage.
Стандарт 2026: «позвони в ресторан, забронируй на 20:00, если нет — спроси 20:30».
Ожидание по рынку: Retell / Vapi, ~$0.10–0.15/мин, ~600 мс, DTMF, перевод на человека.

### Что выяснилось: Retell/Vapi — не путь для RU

**Retell AI блокирует Россию навсегда.** В [fraud-protection](https://docs.retellai.com/reliability/fraud-protection)
RU в списке sanctioned countries вместе с CU/IR/KP/SY/BY/VE. Звонки **в** и **из**
RU отклоняются независимо от dashboard-настроек.

**Vapi** формально не санкционирует RU, но:

- бесплатные номера — только US;
- международные звонки = Twilio/Vonage/Telnyx + geo-permissions;
- SBC в US/EU; нет маркировки 41-ФЗ;
- реальная цена all-in ~$0.10–0.42/мин плюс западный CLI.

**Vonage** — RU на embargo-листе.

**Twilio** технически звонит в +7: mobile **$0.3432/мин**, landline **$0.4348/мин**
([pricing](https://www.twilio.com/en-us/voice/pricing/ru)). Нет русской маркировки,
иностранный CLI, с августа 2026 крупные операторы режут неразмеченные массовые
звонки юрлиц ([обзор](https://riposte.levelflow.org/2026/08/nocalls/)).

**Сравнение западных платформ (для EN-exit, не для RU):**

| | Vapi | Retell |
|---|---|---|
| Модель | Оркестрация, BYO STT/LLM/TTS | Managed appliance |
| Цена | $0.05/мин платформа + провайдеры | $0.07–$0.31/мин all-in; типично ~$0.11 |
| Latency | 500–700 мс (tuned), P95 до 1.5 с | ~600 мс из коробки (580–780) |
| DTMF / warm transfer | Через Twilio, тонкий toolkit | Нативно |
| HIPAA | +$2 000/мес | Включено |
| RU | Только BYOC, без compliance | **Hard block** |

Источники: [Layer3 2026](https://www.layer3labs.io/comparisons/vapi-vs-retell-ai),
[Callers](https://www.callers.ai/blog/retell-vs-vapi/),
[Fora Soft](https://www.forasoft.com/blog/article/vapi-vs-retell-vs-custom).

### Регуляторика RU (важнее выбора вендора)

- **41-ФЗ + ПП 1300 с 01.09.2025:** исходящие от юрлица/ИП должны нести
  **этикетку** (имя, до 32 символов) на экране абонента.
- **Авг 2026:** МегаФон/МТС/Билайн/T2 режут массовые/автоматические звонки
  без договора маркировки. SIP = **МАВ**, ~0.30 ₽/инициация даже без ответа.
- **152-ФЗ:** согласие отдельным документом; запись = ПДн; локализация в РФ.
- **126-ФЗ:** Bro — клиент лицензированного оператора, не оператор сам.
- Голос абонента (клиника/СЦ) лучше не слать в OpenAI/Anthropic live —
  STT в РФ (Yandex / T-Bank / Sber).

### Рабочие вендоры для RU

| Вендор | PSTN RU | Цена (порядок) | STT/TTS RU | DTMF / перевод | Маркировка | Роль |
|---|---|---|---|---|---|---|
| **Zvonok** | да | 0.12 ₽/звонок + 2.42 ₽/мин; AI ~4.72 ₽/мин | встроен | IVR да; warm transfer неясен | вендор заявляет «включено» | **MVP** |
| **Voximplant** | да | мобильный ~$0.022/мин + $0.004 платформа | Yandex/Google | да / да | отдельный сервис | **продакшен** |
| **Mango Office** | да | ВАТС ~1 600 ₽/мес + API 500–7 700 | внешний | да / да | через оператора | рельс + свой мозг |
| Yandex SpeechKit / T-Bank VoiceKit | нет | 0.15–0.60 ₽/мин STT | отлично | — | 152-ФЗ | только медиа |
| LiveKit / Pipecat | через RU SIP | своё | Sber/Yandex | да | = SIP | если уже есть оркестрация |

Доказанный кейс: [DocDoc на Voximplant](https://voximplant.com/case-studies/docdoc) —
голосбот звонит в клинику, передаёт ФИО/дату/телефон, пишет результат в CRM,
запись звонка сохраняется. Ровно сценарий Bro.

### Как ложится на jobs (без нового рантайма)

```
iMessage «позвони в клинику X на 20:00»
  → job_open + phone_call tool
  → Convex action → Zvonok/Voximplant API
  → job_wait(waitingFor: "call")
  → POST /webhooks/call?h=  (зеркало /webhooks/mail)
  → tagged [event:call] в тред, не как речь человека
  → первое iMessage: «Записал на 20:30, сказали свободнее»
```

Схема: расширить `waitingFor` литералом `"call"`; поля
`callProvider`, `callExternalId`, `callRecordingUrl`. Гейты до звонка:
явное «Bro может звонить третьим лицам», этикетка номера Bro (не личного),
дисклеймер записи в начале разговора, записи на RU-серверах.

**Не строить на Retell/Vapi для RU.** Для EN-exit — Retell как managed
быстрый старт, Vapi если сами крутим стек.

### Поправка: Inkbox уже голос, Retell не обязателен

Inkbox — не «только iMessage». У identity три поверхности: почта, iMessage,
опциональный **phone number**. Phone API уже умеет ровно то, что кажется
«подключить голосовую модель»:

- `POST /place-call` + `mode="hosted_agent"` + `reason` — Inkbox Voice AI
  сам ведёт звонок, без WebSocket и без Retell
  ([hosted-call-agent](https://inkbox.ai/docs/capabilities/phone/hosted-call-agent))
- или `client_websocket_url` — ваш мозг, Inkbox делает STT/TTS
- `call.ended` вебхук: транскрипт + `outcome` + action items

Bro сегодня **не использует** этот API: провижинится только iMessage
(`claim_imessage_number`), не `phone_numbers`.

Три линии исходящего, это не одно и то же:

| Origination | Что это | Кому можно звонить |
|---|---|---|
| `shared_imessage_number` | скрытая линия роутера | только человеку, уже связанному с агентом в iMessage |
| `dedicated_imessage_number` | свой iMessage-номер | голос с этой линии, если она voice-enabled |
| `dedicated_number` | PSTN, `type` только `local`, фильтр `state: "NY"` | произвольный E.164 — **если страна линии включена** |

Ошибка API: `destination_country_not_enabled` (D13) —
«наберите support, чтобы включить страну». Номера Inkbox — US local;
+7 по умолчанию, скорее всего, выключен. Даже если включат: клиника в
Москве часто не берёт неизвестный +1, нет 41-ФЗ этикетки, запись/STT
уходит на инфру Inkbox (152-ФЗ).

`hosted_agent` не крутит ваши тулы mid-call — пакет после трубки.
IVR «нажмите 1» и живой русский диалог — отдельный вопрос к качеству
их Voice AI, не к наличию API.

Квота: 30 мин/номер/мес на Developer/Startup, оверэйдж $0.03/мин.

**Вывод:** «номер + голосовая модель» — это нативный путь Inkbox, не
Retell. Для звонка *пользователю* Bro или US-ресторану — сначала
`hosted_agent`. Для «позвони в российскую клинику» узкое место не мозг,
а последняя миля PSTN в +7. Спайк: один `place-call` на +7 и письмо
в support про RU destination. Если D13 / не берут трубку — Voximplant
как ствол, eve как мозг.

---

## 6. Сторожа 2.0: push вместо поллинга

### Что хотели

Composio API v3.1 → вебхук в `convex/http.ts` → сторож мгновенный и бесплатный
по токенам. Поллинг Bro оставить только для цен/сайтов без вебхуков.

### Что выяснилось: «push к вам» ≠ «мгновенно от Google»

Два слоя ([docs/triggers](https://docs.composio.dev/docs/triggers)):

| Слой | Как | Latency | Кто платит |
|---|---|---|---|
| Provider → Composio | Gmail/Calendar = **poll** Composio | до ~15 мин на managed OAuth; Gmail FAQ — ~1 мин default | Composio |
| Composio → Bro | всегда **подписанный POST** | сразу после детекта | $0.003/event после 50K free |

С 11.03.2026 дефолт polling interval **15 мин**, минимум 15 мин на
Composio-managed auth; свой OAuth — от 1 мин
([changelog](https://github.com/ComposioHQ/composio/blob/next/docs/content/changelog/03-11-26-polling-interval-changes.mdx)).
Outlook/Slack/Notion — настоящий realtime.

**Это всё равно победа.** Сейчас сторож жрёт ход агента каждые N минут на
«проверь и сравни lastSeen». С триггером: тишина = $0 токенов.

### Слаги и полезный payload

Gmail (оба `type: poll`):

- `GMAIL_NEW_GMAIL_MESSAGE` — `query` / `labelIds` / `interval`
- `GMAIL_EMAIL_SENT_TRIGGER`

Calendar:

- **`GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER`** — один триггер,
  create/update/delete + полное тело события (рекомендуемый дефолт)
- `…_EVENT_CREATED_TRIGGER`, `…_UPDATED_TRIGGER`, `EVENT_CANCELED_DELETED_TRIGGER`
- `EVENT_STARTING_SOON_TRIGGER` (`minutesBeforeStart`)
- `GOOGLE_CALENDAR_EVENT_CHANGE_TRIGGER` — webhook, **deprecated**, только метаданные

Конверт V3 (дефолт новых орг):

```json
{
  "id": "msg_…",
  "type": "composio.trigger.message",
  "metadata": {
    "trigger_slug": "GMAIL_NEW_GMAIL_MESSAGE",
    "trigger_id": "ti_…",
    "user_id": "bro-+7900…",
    "connected_account_id": "ca_…"
  },
  "data": { "sender": "…", "subject": "…", "message_text": "…" }
}
```

API: `POST /api/v3.1/trigger_instances/{slug}/upsert` → `ti_*`.
Один webhook URL на проект: `triggers.setWebhookSubscription`.
Подпись: `HMAC-SHA256("{webhook-id}.{webhook-timestamp}.{rawBody}")`,
заголовки `webhook-signature` / `webhook-id` / `webhook-timestamp`,
окно 300 с. IPs динамические — не allowlist, только HMAC.

Цена ([composio.dev/pricing](https://composio.dev/pricing)): 50K trigger events
бесплатно, дальше $0.003. Биллинг **за доставленное событие, не за poll**.

### Архитектура в Bro

```
Composio POST → convex/http.ts /webhooks/composio
  → verify + idempotency(webhook-id)
  → lookup watcher по ti_* / (user_id + slug)
  → Tier 0: детерминированный фильтр (query уже на стороне Composio)
  → Tier 1: шаблонное iMessage без LLM («Письмо от банка: …»)
  → Tier 2: ход агента только если requiresJudgment
```

Поллинг Bro оставить для: цены WB/Ozon, произвольные сайты, всё без trigger slug.
Ультранизкая latency Gmail (<1 мин) — свой OAuth + Google Pub/Sub, не Composio.

Нюанс текущей схемы: один watcher на человека (дедуп kind). Триггеры это ломают
в хорошую сторону — много `ti_*` на тенанта. Индекс `by_tenant` + таблица
`watchers { tenant, slug, triggerId, config, notifyMode }`.

---

## 7. Память 2.0

### Что есть сейчас

`memories.line` ≤280, exact-dedup последних 20, substring по 200,
**80 строк в каждый промпт** (`convex/memories.ts` + `agent/instructions/memory.ts`).
≈5.5–7K токенов/ход независимо от запроса. Два адреса живут рядом.

### Рынок 2026 (цифры спорные, паттерн нет)

| | Mem0 | Zep / Graphiti | Convex vectorIndex |
|---|---|---|---|
| Модель | вектор + опц. граф | битемпоральный граф | ваша схема + embedding[] |
| Консолидация | ADD/UPDATE/DELETE в paper; Platform v3 часто ADD-only + Dream (Pro $249) | invalidate old edge, история жива | пишем сами (scheduler) |
| Latency | search p50 148 мс (paper) | retrieval p50 87–162 мс (маркетинг) | embed API + vectorSearch ~100–300 мс |
| Цена | $0 / $19 / **$249 за граф** | Free / Flex (цифры плывут $25–$125) | search storage 1 ГБ в Pro, оверхед копеечный |
| Новый рантайм | да (или Docker+pgvector+Neo4j) | да (Neo4j 5.26+) | **нет** |
| Temporal | нет нативных окон | `valid_at` / `invalid_at` | поля `validFrom` / `invalidAt` |

Бенчмарки **не выбирать вендора**: LoCoMo у Zep гуляет 58–94% в зависимости
от судьи и промпта ([спор](https://github.com/getzep/zep-papers/issues/5)).
LongMemEval (knowledge-update — «адрес в марте») релевантнее LoCoMo.

### Минимальный шаг без зависимостей (рекомендация)

**Шаг 1 — retrieval, не dump**

- Поля: `embedding`, `status`, `validFrom`, `invalidAt?`, `category?`
- `.vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 1536, filterFields: ["phoneE164", "status"] })`
- Wake: 5–10 свежих `status:"active"` + top-5 vector по последнему сообщению
- Embed: `text-embedding-3-small` из уже существующего LLM-ключа
- `vectorSearch` только из **action** (ограничение Convex), limit 1–256,
  фильтры только `eq` / `or`

[Доки Convex](https://docs.convex.dev/search/vector-search).

**Шаг 2 — консолидация ADD/UPDATE/DELETE**

После `note`: `scheduler.runAfter(0, consolidate)`.
LLM по top-5 похожим: `{op, targetId?, text}`.
UPDATE патчит и переэмбедит; DELETE = `status:"superseded"` + `invalidAt=now`
(не hard-delete). Wake видит только active.

Русский: начать с `text-embedding-3-small`; если recall слабый —
`multilingual-e5-large-instruct` (1024 dims, сменить schema).
Не тащить Mem0/Zep, пока нет мультихопа «кто был на дне рождения у X».

---

## 8. Agentic commerce: подтверждение в 1 клик

### ACP (OpenAI + Stripe) — знать, не внедрять в RU

- Спека открытая, maintainers OpenAI + Stripe, beta, версия `2026-04-17`.
- Checkout sessions + **Delegated Payment**: одноразовый токен с
  `max_amount`, `merchant_id`, `expires_at`, `reason: one_time`.
- Instant Checkout в ChatGPT (сен 2025) **сжался к марту 2026** — пилот
  не стал массовым; паттерн «корзина + явное ОК + scoped token» остался.
- PSP в спеке: Stripe / Adyen / Braintree. Instant Checkout = US.
- Репозиторий: [agentic-commerce-protocol](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol).
- Stripe SPT: US/CA/часть EU, не РФ.

**Почему не Bro/RU:** WB/Ozon не отдают ACP; ЮKassa/СБП/Мир не в списке;
Bro ходит браузером по сайту, а не в REST checkout мерчанта.

RU-аналог горизонта: ЮKassa `payment_method_id` после привязки СБП/карты.
Это абонплата Bro, не оплата корзины на Ozon.

### Что строить сейчас

Inkbox P2P **не умеет** кнопки, list picker, Apple Pay. Только текст, 1 media,
tapbacks. Messages for Business (list picker / time picker / Apple Pay) —
другой канал; Poke туда зашёл в июне 2026 как verified business, Bro — нет.

Карточка текстом + уже существующий `waitingFor: "human"`:

```
🛒 Корзина · 4 200 ₽
• Nike Air Max 90, 42 — 3 890 ₽
• ПВЗ Ozon, Ленина 12 — 310 ₽
Итого: 4 200 ₽. Оплата на сайте (карта / СБП).

Отправить? «да» / «нет» (или 👍 на это сообщение)
```

Правила (в state machine, не в промпте):

- «да» / «отправляй» / «1» / 👍 → дальше; иначе переспросить;
- цена сдвинулась — новая карточка;
- TTL ~15 мин, потом «окно закрылось»;
- v1 человек по-прежнему платит на `liveUrl`; Bro не жмёт «Оплатить».

Конкуренты тем же паттерном: Shop skill `--confirm`, Lindy «Ask for Confirmation»,
Stripe Link spend request, ChatGPT Buy button. Bain: ~24% готовы к покупке
без ревью — Bro держит 100% confirm.

---

## Moonshot A. Семейный консьерж

Один платящий, несколько номеров, общие сторожа.

Прецеденты: Apple Family Sharing (делят подписку, **не файлы**);
Lindy Team (общий пул кредитов, не семья);
Poke group chat (напоминание всем в треде, один аккаунт на телефон);
WhatsApp-семейки (Famori / Wassapy): группа + личные 1:1.

Модель: `household` оборачивает `tenants` (члены). Не сливать память.

```
household (payer, plan, pooled limits)
  members[] (phone, role owner|adult|child, consent)
  integrations[] (scope household | member)
  watchers[] (notifyMemberIds[])
  threads[] (dm | group)
```

Приватность по умолчанию: 1:1 A не виден B. Общий только явно scoped вывод.
Дети — интеграции только с согласия owner. 152-ФЗ на каждый номер.

Биллинг: household flat (условно 1 490–2 490 ₽ / $49–79 до 4 номеров)
лучше per-seat. LTV растёт, CAC — если каждый член отдельно OAuth'ит Gmail.

**Lite первым:** общие watchers + group iMessage (нужен dedicated line),
не общая память. Риск бага «жена увидела почту мужа» убивает продукт.

---

## Moonshot B. Bro Recipes

Poke доказал механику ([docs](https://poke.com/docs/creating-recipes),
[TechCrunch апр 2026](https://techcrunch.com/2026/04/08/poke-makes-ai-agents-as-easy-as-sending-a-text/)):

- recipe = onboarding context + required integrations + share link `poke.com/r/…`
- Kitchen UI + `npx poke` CLI + MCP
- выплата автору $0.10–$1 за уникальный signup (гео)
- каталог: health / productivity / travel / email / dev
- цены Poke: $0 / $19 / $199; раньше торг с баунсером $10–30

Bro может скопировать **без приложения**:

```
bro.ai/r/{slug} → sms:/iMessage deep link → connect @handle
  → Convex ставит systemContext + Composio apps + watchers
  → attribution ?ref=creator → payout после retained_7d + 1 интеграция
```

Минимум схемы: `title, locale, systemContext, firstUserMessage,
composioApps[], watchers[], minPlan, creatorId, payoutRule`.

Сид для RU (этого нет у Poke): визовые слоты, Озон/WB цена, ГИБДД, утренний
разбор почты, ДР родственников. iMessage без кнопок — нумерованные ответы.

Выплаты: сначала руками, потом ЮKassa/Stripe Connect. Не платить за голый signup.

---

## Moonshot C. RCS вторым фронтом

Apple: P2P RCS в iOS 18; **RCS for Business с iOS 18.1** — verified sender,
карусели, suggested replies, кнопки. Не iMessage: пузырь зелёный, не E2E.
US big-3 живые; верификация 8–16 недель.

**Россия 2026:** MTS и Beeline — Apple RCS **не поддерживают**
([RCS Composer](https://rcscomposer.com/docs/supported-country/apple/russia/),
обновлено 2026-05-11). MTS RCS — Android, только внутри сети МТС, на вопрос
«работает ли на Apple?» официально «нет».

Inkbox уже умеет `service: imessage | sms | rcs` на dedicated line, Bro
политикой сидит на iMessage.

**Не строить RCS для RU-ниши.** Для EN-exit — карусель «5 отелей» имеет смысл,
с fallback в нумерованный текст. Альтернатива богатого UX на iPhone —
Apple Messages for Business (как Poke), не RCS.

---

## Moonshot D. Выход из RU-ниши

Стек переносим: Inkbox глобальный, Convex, Composio, eve.
Менять: locale/промпты, Stripe вместо ЮKassa, Retell/Vapi вместо
Voximplant, GDPR/CCPA вместо 152-ФЗ-first, дефолт TZ.

Конкуренты и WTP:

| Продукт | Цена | Канал | Заметка |
|---|---|---|---|
| Poke | $0 / $19 / $199 | iMessage / SMS / Telegram | Recipes, Apple MB (июнь 2026), оценка ~$300M |
| Lindy | $30–200 / seat | iMessage + Slack | Team credits; голос от $0.19/мин + $10/номер |
| Friend.com | девайс + ~$10/мес | кулон | не консьерж |
| ChatGPT | $20 | своё приложение | агент внутри чата |

Позиционирование: не «русский Poke».
**«iMessage-консьерж, который дожимает дела, а не черновики»**
(browser follow-through, сторожа, карточка заказа). EN-цена якорь $29 individual /
$59 household.

Poke на Messages for Business — политический прецедент Apple. Имеет смысл
подать заявку при EN-бете, не блокировать RU-roadmap.

---

## Что стыкуется с текущим кодом

| Фича | Существующий примитив | Дельта |
|---|---|---|
| Карточка заказа | `jobs.waitingFor: "human"`, `orders` | парсер да/нет + шаблон карточки + TTL |
| Память 2.0 | `memories`, `wake`/`note`/`search` | embedding + vectorIndex + consolidate action |
| Сторожа 2.0 | `wakeups.kind: watcher`, `convex/http.ts` | `/webhooks/composio`, таблица `watchers`/`ti_*` |
| Звонок | jobs + **Inkbox Phone API уже есть, Bro его не зовёт** | `place-call hosted_agent` + `call.ended`; Voximplant только если +7 закрыт |
| Recipes | wakeups + Composio connect-link | `recipes` + `/r/{slug}` + attribution |
| Family | `tenants` 1:1 phone | `households` + group thread |
| RCS / ACP | — | не сейчас |

---

## Источники (короткий индекс)

Голос: [Retell sanctions](https://docs.retellai.com/reliability/fraud-protection),
[Vapi vs Retell](https://www.layer3labs.io/comparisons/vapi-vs-retell-ai),
[Voximplant DocDoc](https://voximplant.com/case-studies/docdoc),
[Twilio RU](https://www.twilio.com/en-us/voice/pricing/ru),
[Zvonok](https://zvonok.com/ru-ru/services/).

Сторожа: [Composio triggers](https://docs.composio.dev/docs/triggers),
[subscribe](https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events),
[Gmail](https://docs.composio.dev/toolkits/gmail),
[Calendar](https://docs.composio.dev/toolkits/googlecalendar).

Память: [Convex vector](https://docs.convex.dev/search/vector-search),
[Mem0 paper](https://arxiv.org/abs/2504.19413),
[Zep paper](https://arxiv.org/html/2501.13956),
[Mem0 vs Zep](https://vectorize.io/articles/mem0-vs-zep).

Коммерция: [ACP repo](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol),
[Delegated Payment](https://developers.openai.com/commerce/specs/payment),
[Inkbox iMessage](https://inkbox.ai/docs/capabilities/imessage),
[Apple MB interactive](https://register.apple.com/resources/messages/msp-rest-api/type-interactive).

Moonshots: [Poke recipes](https://poke.com/docs/creating-recipes),
[Poke pricing](https://poke.com/),
[Lindy](https://www.lindy.ai/pricing),
[RCS RU](https://rcscomposer.com/docs/supported-country/apple/russia/),
[Sinch Apple RCS](https://sinch.com/blog/apple-support-rcs/).
