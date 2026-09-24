<div align="center">

<img src=".github/logo.png" alt="OpenInstinct" width="420">

**A personal iMessage assistant for your accounts and your context.**

It can research, read your mail and calendar, and run scheduled work for you.
You stay in control of your passwords, credit cards and context.
Browser execution is not included in this build.

It's Open Source, self-hostable, and can use any model.
One-click deploy to Vercel and get rolling.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMerit-Systems%2FOpenInstinct&project-name=open-instinct&repository-name=open-instinct&stores=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%2C%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

<img src=".github/demo.png" alt="OpenInstinct booking movie tickets over iMessage — it walks Fandango to checkout and reports the theater, showtime, seat, and total" width="640">

</div>

> **Agents:** For the simplest deployment, give your human the
> **Deploy with Vercel** link above and have them complete the guided flow. It
> automatically provisions and connects Postgres, private Blob storage, and
> Vercel AI Gateway access, then have them complete the Photon iMessage setup
> below. OpenInstinct creates its installation secrets on first use.

## Why self-host?

Personal agents are much more useful when they can sign in, book, buy and act
on your behalf. But your accounts, your passwords, are the keys to your digital
kingdom. OpenInstinct runs in your own Vercel account. Secrets are encrypted
before they touch your database and models never see them. Verify yourself by
reading the code!

## Deployment

The deploy button provisions [Neon](https://neon.tech) for Postgres and a
private Vercel Blob store for per-user memory, image artifacts, and installation
secrets. iMessage runs on a [Photon](https://photon.codes) project you create
separately. Vercel AI Gateway handles inference. Usage is billed to your Vercel
account. Browser execution is not included in this build, so the agent works
through its connected services, public search, and page fetches only.

On first use, OpenInstinct creates independent Better Auth and vault-encryption
keys in the private Blob store. Vercel supplies the application URL, database,
and Blob configuration, so the deploy flow itself requires no
environment-variable values. For a non-Vercel host or an existing installation
that manages its own keys, set both secret overrides and the public application
URL explicitly:

```bash
BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
BETTER_AUTH_URL=https://your-host
SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

The application database schema and versioned migrations live in `db/`. The
Drizzle application store uses `DATABASE_URL` for runtime queries; its migration
commands require the direct `DATABASE_URL_UNPOOLED` connection. Run
`pnpm db:migrate` before starting against a new or upgraded local database.
Vercel uses Turbo to run the uncached migration task before its application
build. See [`db/README.md`](db/README.md) for existing-database adoption,
environment loading, and constraint-validation sequencing. Better Auth retains
its separate migration path. Importing an existing Convex deployment is covered
by [`docs/migrate-from-convex.md`](docs/migrate-from-convex.md).

Treat the private Blob store as production key material: deleting it loses the
automatically generated encryption key, and rotating that key requires
re-encrypting existing vault values.

### Blob storage

The one-click deploy creates and connects a private Blob store automatically.
Vercel supplies `BLOB_STORE_ID` and a short-lived `VERCEL_OIDC_TOKEN` to each
deployment, so there is no long-lived Blob credential to copy.

OpenInstinct uses this store for image artifacts and as the retained source for
the one-time migration of legacy profile memory. New profile facts are stored as
revisioned database records. See [the memory architecture](docs/memory.md) for
the authority, semantic-index, deletion, and rollout contracts.

Ongoing undertakings use a separate `workstreams` memory slot backed by the
application database. Run the application migrations before using this feature;
it needs no additional service or credentials. The root agent can save goals,
constraints, decisions, source-linked observations, and unresolved steps across
conversations. It recalls an index of the eight most recently updated active or
waiting workstreams, then reads the selected record before continuing. Older and
completed workstreams remain searchable.

Workstreams are scoped by authenticated workspace and Eve's deployment-aware
memory key. Updates require the current revision. Each scope retains content for up to 100
bounded records; the agent asks which obsolete record to forget at capacity.
Forgetting erases the content and source references, retaining only a tombstone
to prevent an interrupted save from restoring them. Existing chat history is
unchanged. This slot is available only in interactive root turns; remembering
work does not start a job, create a schedule, or authorize an action.

For an existing Vercel project, link it first with
`eve link --project <your-vercel-project> --non-interactive`, then create and
connect the store with one command:

```bash
pnpm exec vercel blob create-store open-instinct-images --access private --yes --environment production --environment preview --environment development
```

Outside Vercel, set `BLOB_READ_WRITE_TOKEN` from a private Blob store instead.
Legacy profile import and image artifact delivery use that store.

### Photon iMessage setup

iMessage uses portable [Photon](https://photon.codes) project credentials, so it
works on Vercel and on any other host. After the first deployment:

1. Create a Photon project and register its iMessage line.
2. Register a Photon webhook for `https://<your-host>/eve/v1/photon` and copy its
   signing secret.
3. Set the three variables in the host's encrypted environment:

```bash
vercel env add IMESSAGE_PROJECT_ID production
vercel env add IMESSAGE_PROJECT_SECRET production
vercel env add IMESSAGE_WEBHOOK_SECRET production
vercel deploy --prod
```

Repeat the variables for preview or development if those environments should
send and receive iMessage too. `IMESSAGE_PHONE_NUMBER` is an optional E.164
override that adds a click-to-message shortcut in the workspace and on the
sign-in screen; delivery itself uses the project's registered line.

No separate per-user verification step is required. A sign-in code is sent to
the phone number entered on the sign-in screen, and a first message from an
unknown number creates that user's account, because Photon delivering the
message already proves possession of the number.

### Browser Use Cloud

`browser_task` runs a website errand — sign in, fill the form, finish the
checkout — in a hosted [Browser Use](https://browser-use.com) cloud browser.
The tool, and the instructions that describe it, appear only when
`BROWSER_USE_API_KEY` is set; without it the agent says plainly that it cannot
operate a website.

1. Create a Browser Use Cloud project and copy its API key.
2. Register a webhook for `https://<your-host>/eve/v1/browser-use` in the
   Browser Use dashboard (Settings → Webhooks) and copy its signing secret.
   Optional: Browser Use sends webhooks for V2 tasks and V3 sessions only, and
   the errands run on the V4 API. Completion is found by the poller, which
   checks open runs every few seconds while any are running.
3. Set the variables in the host's encrypted environment:

```bash
vercel env add BROWSER_USE_API_KEY production
vercel env add BROWSER_USE_WEBHOOK_SECRET production
vercel deploy --prod
```

`BROWSER_USE_MAX_COST_USD` is the ceiling every run is created with and defaults
to `1`: Browser Use stops a run that reaches it, so a task that loops or wanders
into an expensive site cannot keep spending unattended. Raise it for errands
that genuinely need longer sessions.

`BROWSER_USE_PROXY_COUNTRY` is the ISO 3166-1 alpha-2 residential-proxy country
every run browses through and defaults to `ru`. `BROWSER_USE_MODEL` overrides
the hosted agent the cloud runs; leaving it unset uses the v4 API's documented
default. `BROWSER_USE_BASE_URL` overrides the API origin and exists so a staging
deployment can point at a stand-in.

Each workspace keeps one persistent Browser Use profile, so a site stays signed
in between errands. Saved vault logins are bound to the exact origin they were
saved for, and the saved card is bound only when the user approved paying on
that errand; the values are typed by Browser Use and are never visible to any
model in this system.

A one-time code sent as a follow-up is typed straight into the page the run is
on, over the Chrome DevTools Protocol, before the hosted agent is asked to do
anything with it. The agent could type it — this is a shortcut, not a repair —
but a queued message waits for its next step, and a code that arrives after the
run has finished costs a whole new run before anyone touches the keyboard. Bank
codes expire in a couple of minutes, so that gap is the difference between a
payment that goes through and one the person starts over.

The search covers embedded frames, which is the whole point: a bank's 3-D
Secure challenge is a cross-origin iframe, and the page's own document does not
contain its field. Every frame is scored before anything is typed anywhere and
only the best one is filled, so a page carrying a bank frame and three ad
frames cannot get the code sprayed across all four; the page's own document
keeps a tie, an embedded frame needs a naming signal rather than merely a
focused input, and a frame too small to hold a form is skipped whatever its
input is named. A password field is never filled and a pay or order button is
never pressed. Whatever the entry does, the person's message still reaches the
hosted agent, which is told what is already in the page so it does not type the
code a second time; when no field can be identified with confidence, nothing is
typed and the agent handles the code exactly as it did before.

`npm run cdp:probe` checks that against a real Chromium, with the code field
inside a cross-site frame and an ad frame, a 0x0 tracking frame, a password
field and a pay button around it. `npm run cdp:probe:cloud` runs the same walk
against a real Browser Use browser through the production path, to catch the
vendor fronting the protocol in a way a flattened auto-attach cannot survive;
it costs about a cent and always stops the browser afterwards. Neither is part
of `pnpm check`, which stays offline.

### Telegram setup

Telegram is a second conversation channel for an account that already exists.
A person links their Telegram once, and afterwards messages from that Telegram
account run as the same user, workspace, memory, vault, and schedules.

1. Create a bot with [@BotFather](https://t.me/BotFather), then copy its token
   and its username (the handle without the leading `@`).
2. Set the three variables in the host's encrypted environment:

```bash
vercel env add TELEGRAM_BOT_TOKEN production
vercel env add TELEGRAM_BOT_USERNAME production
vercel env add TELEGRAM_WEBHOOK_SECRET_TOKEN production
vercel deploy --prod
```

`TELEGRAM_WEBHOOK_SECRET_TOKEN` is a secret you choose; Telegram echoes it back
in the `X-Telegram-Bot-Api-Secret-Token` header, and inbound webhooks that do
not carry it are rejected.

3. Point the bot at the deployment's webhook route:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<your-host>/eve/v1/telegram",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'",
       "allowed_updates":["message","callback_query"]}'
```

To link an account, open the workspace page and choose **Link Telegram**, or ask
the assistant over iMessage to link Telegram. Either one mints a one-time
`https://t.me/<bot>?start=link_<token>` deep link that expires after 30 minutes.
Opening it in Telegram binds that Telegram account to the workspace. One
Telegram account maps to exactly one workspace, and one workspace holds at most
one Telegram account.

Only private chats reach the agent; group messages are ignored. A message from
an unlinked Telegram account gets one short explanation of how to link, at most
once an hour per chat.

### Inbound photos and voice notes

A photo, an image or PDF document, or a voice note sent over Telegram or
iMessage reaches the model as bytes the channel downloaded itself, not as a
URL. Photos are served at the largest rendition under 3 MB with the media type
read from the file's magic bytes; PDFs up to 10 MB become file parts; other
files are described to the model in one line. A message that carries only a
picture still tells the model `[фото]`.

Voice notes are transcribed through OpenRouter's audio endpoint with
`OPENROUTER_API_KEY`, so a deployment without the key answers a voice note with
one line saying voice is not supported. iMessage voice notes arrive as
CAF-Opus and are remuxed to Ogg in process. `OPENROUTER_STT_MODEL` is the
transcription model (default `qwen/qwen3-asr-flash-2026-02-10`),
`OPENROUTER_STT_FALLBACK_MODEL` takes over when the first model rejects the clip
(default `openai/gpt-4o-transcribe`), and `OPENROUTER_STT_LANGUAGE` is the
language hint (default `ru`; `auto` lets the model guess). The transcript
reaches the model as a line starting with `[голосовое]`; when nothing could be
transcribed and the message has no text, the person is asked to retry and no
model turn runs.

When the model provider refuses a turn (out of credits, rate limited, down),
Telegram and iMessage answer the person with a short «я прилёг, скоро вернусь»
(or its English twin for someone writing in English) instead of silence; any
other failed turn gets a short apology. To hear about an empty balance before
people do, set `OPENROUTER_MANAGEMENT_KEY` (the credits endpoint rejects an
inference key) and `TELEGRAM_OWNER_CHAT_ID`. Every ten minutes the schedule
reads the OpenRouter balance and, when it falls below
`OPENROUTER_CREDITS_ALERT_USD` (default 5), messages the owner through the bot.
The alert repeats once a day while the balance stays low, sooner if it keeps
halving, and re-arms once the balance recovers; its state lives in
`operational_alerts`.

### Pictures and chat games

With `OPENROUTER_API_KEY` and private Blob storage, the agent gets a
`generate_image` tool that draws through OpenRouter's Image API. The model is
`OPENROUTER_IMAGE_MODEL` (default `google/gemini-3.1-flash-lite-image`) and must accept
reference images: the person's photos from the conversation (up to the four
newest) and earlier pictures travel as references, so a card can show the
person's own dog and "make it brighter" edits the last version instead of
starting over. Pictures are stored as private artifacts and reach Telegram and
iMessage as real photos through `send_message`. Without the key or the store the
tool is not offered, and the agent says plainly that it cannot draw.

Chat games need no configuration: the agent hosts trivia and other games in the
conversation one question per message, reacts to answers, and keeps score.

## Landing and onboarding

`/` is a public Russian landing page and the signed-in workspace lives at
`/workspace`. The landing asks for nothing: under the film there is one call to
action, «Написать бро», an `sms:` deep link into `IMESSAGE_PHONE_NUMBER` with
«Привет» prefilled, and the number itself underneath for a visitor who is not
on an iPhone right now. No account is created here: the first inbound iMessage
creates it, so nothing is provisioned before a person actually writes. A deployment without `IMESSAGE_PHONE_NUMBER` has no line to open and
says onboarding is closed instead of linking into nowhere.

The film and the og image are served from `/brand`, which the auth proxy must
not touch: its matcher excludes those paths, because a static asset redirected
to `/sign-in` is an asset that silently disappears from the page.

`scripts/lib/migrate-from-convex.ts` still registers a Photon `shared` user per
migrated phone and stores it in the `onboarding_requests` table, which replays
the number a phone already has instead of buying a second Photon user.

`/oferta` carries the Russian public offer the landing links to.

## Оплата и лимиты

Доступ платный помесячно через YooKassa. `YOOKASSA_SHOP_ID` и
`YOOKASSA_SECRET_KEY` вместе включают оплату; без любого из них деплой работает
в бесплатном режиме — лимиты те же, ссылки на оплату нет. `PRICE_RUB`
(по умолчанию 2000) — цена месяца.

`GET /api/pay` создаёт платёж для кабинета вошедшего пользователя и
перекидывает браузер на подтверждение YooKassa; `return_url` ведёт на
`/workspace?paid=1`. `POST /api/yookassa` — публичный вебхук: из тела он берёт
только идентификатор платежа, перезапрашивает платёж у YooKassa и только после
этого продлевает доступ на 30 дней от максимума из «сейчас» и текущей даты
окончания. Продление идемпотентно по идентификатору платежа. В кабинете строка
«Подписка» показывает состояние и ссылку на оплату.

`USAGE_LIMITS` включает или выключает лимиты целиком; по умолчанию `off` —
закрытая бета идёт без лимитов по решению владельца, и оплата в чате не
предлагается. При `USAGE_LIMITS=on` лимиты считаются по рабочему
пространству: сообщения — за местный день, браузерные поручения и
нарисованные картинки — за местный месяц. `FREE_MESSAGES_PER_DAY` (30),
`PAID_MESSAGES_PER_DAY` (500), `FREE_BROWSER_RUNS_PER_MONTH` (5),
`PAID_BROWSER_RUNS_PER_MONTH` (60), `FREE_IMAGE_GENERATIONS_PER_MONTH` (10),
`PAID_IMAGE_GENERATIONS_PER_MONTH` (100).
Местный день и месяц берутся из таймзоны в Personal Info, по умолчанию
`Europe/Moscow`. За лимитом сообщений человек один раз в день получает
сообщение о лимите со ссылкой на оплату, остальные сообщения тихо
отбрасываются; за лимитом поручений `browser_task` не запускается, а за
лимитом картинок `generate_image` не рисует, и оба возвращают модели
объяснение.

## Connected apps (Google, Notion, Slack and more)

People connect their own accounts through [Composio](https://composio.dev):
Composio stores and refreshes the grants, and Bro calls the apps through
Composio's proxy and tools with the person's connected account id, so no
provider token ever reaches Bro. The Composio `user_id` is the Bro user id.
Without `COMPOSIO_API_KEY` the integrations are absent.

1. Create a Composio project and a project API key; set `COMPOSIO_API_KEY`.
2. Create Composio-managed OAuth auth configs and set their ids:
   - `googlesuper` for Gmail, Calendar, Drive, Contacts, Sheets and Docs in
     one consent → `COMPOSIO_GOOGLE_AUTH_CONFIG_ID`, and optionally a second
     one for the read-only level → `COMPOSIO_GOOGLE_READ_ONLY_AUTH_CONFIG_ID`
     (without it read-only reuses the full one and Bro refuses writes itself);
   - `notion` → `COMPOSIO_NOTION_AUTH_CONFIG_ID`;
   - `slack` with user-token scopes → `COMPOSIO_SLACK_AUTH_CONFIG_ID`.
     Scopes (`credentials.scopes` of the managed config): full Google —
     `userinfo.email`, `userinfo.profile`, `https://mail.google.com/`,
     `calendar`, `contacts.readonly`, `drive`, `spreadsheets`, `documents`;
     read-only Google — the same without `spreadsheets` and `documents`; Slack —
     `channels:history,channels:read,chat:write,groups:history,groups:read,im:history,im:read,im:write,mpim:history,mpim:read,search:read,users:read,users:read.email`
     (Composio sends them as `user_scope`); Notion takes none. Other apps
     reached through the `apps` tool get a managed auth config on first connect.
3. People connect from the chat (a sign-in card, `connect_google`,
   `connect_app`) or from `/workspace`; disconnecting revokes and deletes the
   Composio connected account.

Gotchas:

- Composio's managed Google app is approved for broad scopes only; narrower
  read-only scopes outside its approved set can be blocked by Google. A truly
  narrow read-only grant needs your own Google OAuth client in its own auth
  config.
- Sending email, creating calendar events, adding Notion tasks, posting to
  Slack and every write through `apps` always require approval. Calendar
  events with attendees send Google invitations.
- Google Contacts search uses a provider-side lazy cache, so a contact created
  moments ago may not appear immediately.

## Local development

The **Deploy with Vercel** flow above is the simplest way to run OpenInstinct. It
provisions the required services and credentials automatically. Local
development is a manual path and requires:

- Node.js 24 and pnpm 11.24.0
- Docker Desktop or another running Docker Compose installation
- AI Gateway access from an API key or a linked Vercel project's OIDC token

First clone and install the application:

```bash
git clone https://github.com/Merit-Systems/OpenInstinct.git
cd OpenInstinct
pnpm install --frozen-lockfile
```

### Model provider

Inference runs through the Vercel AI Gateway by default, which bills your Vercel
account and refuses most models on the free tier — a Gateway deployment needs
paid credits. Set `OPENROUTER_API_KEY` to route every turn through
[OpenRouter](https://openrouter.ai) instead. OpenRouter then owns model
selection: `OPENROUTER_MODEL` is the default id for a workspace that has not
chosen one, `OPENROUTER_MODEL_CONTEXT_TOKENS` declares the context window,
`OPENROUTER_PROVIDER_ORDER` pins upstream hosts, and
`OPENROUTER_REASONING_EFFORT` turns the thinking phase on at `low`, `medium`, or
`high`. The workspace page switches its model picker to an OpenRouter id field
whenever the key is present.

`web_search` changes shape with the provider. The framework tool is
provider-managed: an AI Gateway model searches through Exa, and a direct
provider model is handed that provider's own search tool. OpenRouter exposes
neither, so with `OPENROUTER_API_KEY` set the agent swaps in its own ordinary
function tool, which runs the query through OpenRouter's `web` plugin on Exa,
falls back to Perplexity on a timeout, a throttle, a gateway failure or an
empty answer, and returns up to eight titles, URLs, and page excerpts; `sites`
limits it to given sites. `OPENROUTER_SEARCH_MODEL` picks the model the plugin
hands the results to (nothing it writes is read) and falls back to
`OPENROUTER_MODEL`. The tool keeps the name `web_search`, and `web_fetch` is
unaffected because it is an ordinary function tool on every provider.

For fully manual setup, copy the environment template and add your AI Gateway
key:

```bash
cp .env.example .env.local

# Set AI_GATEWAY_API_KEY in .env.local.
```

If you already use a Vercel project, link it to pull AI Gateway access:

```bash
pnpm exec eve link --project <your-vercel-project> --non-interactive
```

Then start OpenInstinct:

```bash
pnpm dev
```

`pnpm dev` starts PostgreSQL from `compose.yaml`, applies the committed database
migrations, and starts the application. Stopping the development process also
stops and removes the PostgreSQL container; its data remains in the
`postgres-data` volume for the next run. Run `pnpm dev:app` when intentionally
using an externally managed database instead.

Local development otherwise uses the same vault and AI Gateway path as the
Vercel deployment. Better Auth and vault encryption use stable
local-only defaults when their variables are unset. Vercel deployments
provision them automatically in private Blob; other production hosts require
explicit secrets.

> [!WARNING]
> This is not software intended for production use.

---

<div align="center">

Built on [Vercel](https://vercel.com) · [Photon](https://photon.codes) · [Neon](https://neon.tech)

</div>
