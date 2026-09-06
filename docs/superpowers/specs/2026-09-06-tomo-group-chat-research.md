# Tomo group chats — research brief for Bro

Date: 2026-09-06
Purpose: copy Tomo’s “add the AI to an iMessage group” product, not the
open-source CLI also named Tomo.

**Verdict.** Tomo does not ship a documented “Add to group” button, invite
link, or special handle. Official copy only says Tomo *can* join group chats.
The real UX is native iMessage: save Tomo as a contact (a phone number you
text), then add that contact to a blue-bubble group. Linq, Tomo’s iMessage
provider, called this a **hidden feature**. Bro can copy that contact-add
flow, but Inkbox shared-router identities stay 1:1 — groups need a dedicated
line.

Do not confuse Mapo Labs’ consumer product (`tomo.ai`) with the unrelated
self-hosted `tomo-ai` npm / GitHub agent (`/summon`, `groupSecret`). That
stack is not what users add in iMessage.

---

## 1. Official Tomo docs / help / landing

There is **no help center**. Site nav is Get started, Login, About, Love,
Careers, Terms, Privacy, X. Support is email `hello@tomo.ai` plus a phone
number so they can find the account. The About FAQ never explains groups.

### Landing — https://tomo.ai/

CTA: **“Text your Tomo”**. No group-chat copy on the homepage.

### About — https://tomo.ai/about

> Tomo is personal AI that lives in your texts and helps make your wishes come true.

> Tomo can join group chats, send reminders, watch videos, edit photos, and connect to your calendar, email, and more.

FAQ “What can Tomo do?” does **not** repeat groups:

> Aside from being fun to text, Tomo can search the web, manage your life (including your calendar and email), and proactively message you to keep you on track!

Support:

> You can email hello@tomo.ai to talk to a (human) member of the Tomo team. Make sure to include your phone number in the email so we can find your account.

### Official seed announcement — Business Wire, 2026-06-25

https://www.businesswire.com/news/home/20260625645270/en/Tomo-is-the-AI-Champion-Helping-People-Bet-on-Themselves-Emerging-from-Stealth-with-5-Million

> Tomo is deceptively simple: it's a phone number you text.

> Tomo can join group chats, send reminders, watch videos, edit photos and connect to your calendar, email, Notion and Google Drive.

Same sentence appears on third-party pages that reprint the release
(Morningstar, Pulse2, aVenture, The AI Insider).

### App Store — Tomo: Your Personal AI (`id6757726935`)

https://apps.apple.com/app/tomo-your-personal-ai/id6757726935

Companion app. Copy is 1:1 / in-app. **No group-chat mention.**

> Works in iMessage or in-app: You can message Tomo right in your texts, or open the app for a richer home.

### Privacy — https://tomo.ai/privacy (updated 2026-06-23)

No group-specific section. Collected data includes phone number and
“any user-generated content you submit through the Service.” FAQ on About:

> Tomo stores the messages and other content you send so it can respond, remember context, and operate the service. We never sell your personal conversations.

Implication: a group thread Tomo sits in is stored like any other content.
There is no published “group messages are isolated” or “only the inviter’s
account owns this” statement.

### Terms — https://tomo.ai/terms (updated 2025-10-06)

Communications consent is by phone number / email. No group clause.

### Pages that do **not** exist

Searched `site:tomo.ai` help / docs / FAQ / “add to group” / “group chat”
beyond the About one-liner. No help.tomo.ai, no /help, no /docs, no
step-by-step.

---

## 2. Exact user flow (what Tomo actually does)

### What is proven

1. Tomo is a **phone number**, not a bot handle or deep link.
   Business Wire: “it's a phone number you text.”
2. Public number published by a Tomo intern (Carson Packard, LinkedIn,
   around the June 2026 seed): **+1 (415) 770-0115**.
   https://www.linkedin.com/posts/carson-packard_its-1-am-and-an-ai-is-texting-me-about-activity-7475946379899510784-CkGG
   Quote: “Bet on yourself and try Tomo today: text +1 (415) 770-0115”
3. Homepage CTA “Text your Tomo” opens Messages to that line (same pattern
   Bro already uses with Inkbox `sms_link`).
4. Linq customer story (Tomo’s own infra partner), 2025-03-25:
   https://linqapp.com/blog/tomo-customer-story

   > The team is now focused on making Tomo more helpful and fun to use with friends. One example: group chats — currently a hidden feature that only the most curious users have discovered, but one the team sees as a natural extension of the product.

   > Tomo launched with a single phone line.

### Reconstructed flow (high confidence; not printed by Tomo)

There is no official “how to add Tomo to a group” page. The hidden-feature
comment plus “phone number you text” plus native iMessage membership imply:

1. User texts Tomo 1:1 (landing CTA or `+14157700115`).
2. User saves Tomo as a contact (name “Tomo”, that number). Apple will not
   offer a mention chip until the number is a contact.
3. **Add to an existing group (3+ people already):**
   Messages → group → tap group icon → **Add** → pick Tomo / type the
   number. Apple:
   https://support.apple.com/guide/iphone/iphb10c80fc5/ios
4. **Or start a new group:** compose → To: friend(s) + Tomo → send.
   A 1:1 thread cannot be expanded in place; Apple requires a new
   conversation to add a third person.
5. Group must stay **iMessage** (all Apple). One Android / SMS user forces
   a new MMS/RCS thread and drops add/remove.

**Not used (no evidence):**

- Invite link / QR / web join
- Special iMessage handle (`@tomo`) as the add target
- In-1:1 “Add Tomo to a group” composer
- Tomo creating the group and adding the user’s friends (possible on Linq
  API, not the published consumer flow)

Linq *can* add participants from the agent side
(`POST` add-participant on an existing iMessage group). That is how an
agent *starts* a group, not how a user adds Tomo to a friends chat.
Sendblue’s inbound-agent plans match the consumer pattern:

> AI Agent (inbound-initiated) plans can only respond to group chats that the number has been added to — they cannot create new group chats.
> https://docs.sendblue.com/getting-started/groups/

### Why it feels “hidden”

Curious users already have Tomo as a contact and try Add. There is no
onboarding copy, no help article, no App Store mention. That is the
product choice Bro should **not** copy if the feature is meant to be
found.

---

## 3. How Tomo behaves in groups

Tomo has **not** published reply, mention, privacy-isolation, or ownership
rules. Below is (a) what official Tomo text implies, (b) what Linq
documents for the stack Tomo runs on, (c) what must stay marked unknown.

### When it replies

**Unknown from Tomo.** Closest official-adjacent source is Linq’s own
group-agent guide (2026-06-25), same week as Tomo’s seed, same vendor:

https://linqapp.com/blog/building-ai-agents-that-work-in-group-chats

> In a group, most messages are humans talking to each other. The core product question changes from "what should the agent say?" to "should the agent say anything?"

> If it talks too much, people mute it. If it talks too little, it feels broken.

Linq’s open-source example (`linq-team/ai-agent-example`) gates every
inbound group message with a cheap classifier:

| Verdict | When |
| --- | --- |
| `respond` | Mention of the agent name (incl. typos), “AI” / “bot” / “assistant”, a direct question to the agent, or a follow-up to the agent’s last bubble |
| `react` | Short ack (“thanks”, “lol”) — tapback only |
| `ignore` | Human-to-human, default for most traffic |

https://github.com/linq-team/ai-agent-example/

This is **Linq’s reference agent**, not a Tomo changelog. Copy the
architecture (gate ≠ generate), not the “Claude” prompt.

### Mentions / triggers

iMessage mentions are a **contact name** (or `@Name`), not a bot slash
command. Apple:

> You can also mention a contact in Messages by typing @ followed by the contact’s name.

Linq inbound: `mentions[].is_me` on `message.received` text parts. Only
iMessage senders produce mention metadata; SMS/RCS arrive as plain text.
https://docs.linqapp.com/channel/imessage/guides/messaging/mentions/

Bro should treat as address:

- iMessage mention of Bro (`is_me` if Inkbox ever exposes it; else name match)
- “бро” / “bro” / “бот” / “агент”
- Reply-to Bro’s last bubble
- A question clearly aimed at the assistant after Bro just spoke

Stay silent on friend-to-friend planning unless asked.

### Privacy

Official: all submitted content is stored; conversations are not sold;
Google Workspace data is not used to train generalized models
(Privacy §16). **No statement that group text is excluded from the
inviter’s 1:1 memory, or that other participants get a consent prompt.**

Linq story on Tomo:

> Tomo's users share deeply personal information through the product. … As users went deeper into the product, they started asking about data privacy.

For Bro: a group is a **new audience**. Do not dump 1:1 vault, card, or
personal memory into a thread other people can read. Say that out loud
the first time Bro speaks in a group.

### Who owns the group session

**Not published.** Reasonable model given “one phone number” + 1:1
accounts keyed by the user’s phone:

- The **line** is Tomo’s (shared or pooled). Anyone who adds that number
  can put Tomo in a group.
- The **paying account** is still the user’s phone number
  (support asks for it; “I changed my phone number” → email hello@tomo.ai).
- A group has many senders. Billing / rate limits almost certainly sit
  on whoever Tomo treats as the bound user — likely the first known
  customer in the participant list, or a shared meter. **Unverified.**
- Linq chats have `owner_handle` (the line that created / holds the
  chat). That is infra ownership, not “this human’s Tomo.”

Open-source `tomo-ai` isolates group sessions and optional `/summon`
into the owner DM. **Do not copy that as Tomo.ai behavior.**

---

## 4. iMessage group-bot plumbing (Inkbox / Linq / Sendblue)

Apple has no public consumer bot API. Providers run real Apple lines.

### Linq — what Tomo uses

https://linqapp.com/blog/tomo-customer-story
https://docs.linqapp.com/channel/imessage/guides/chats/group-chats/
https://linqapp.com/blog/building-ai-agents-that-work-in-group-chats

- Groups are first-class (`is_group`, display name, icon, participant
  add/remove, membership webhooks).
- Create = first send to 2+ `to` handles (3+ people including the line).
- First outbound must **not** contain links.
- Cap 31 recipients on `to`; SMS/MMS fallback often 10–20.
- Add/remove: iMessage groups only; floor of **3 members**.
- Leave is one-way; a new chat with the same people is a new `chat_id`.
- Mentions: send `mention` + display name; receive `mentions[].is_me`.
- Group chats: no delivery/read receipts. Typing indicators **do** work
  (docs note; the 2026 blog said they do not — trust the current guide).
- Recommended product loop: webhook → `isGroup` branch → Haiku
  respond/react/ignore → full model only on `respond` → attribute
  history as `[handle]: text`.

### Inkbox — what Bro uses today

https://inkbox.ai/docs/api/imessage
https://inkbox.ai/docs/api/imessage/groups
https://inkbox.ai/docs/api/imessage/webhooks

Hard gate:

> iMessage group chats … are available to identities with an active attached dedicated iMessage line. **Shared-service conversations remain 1:1.**

Bro default is the shared router (`connect @handle`). That path **cannot**
receive or send groups. Dedicated line (`BRO_DEDICATED_LINE=1` /
`claimIMessageNumber`) is required.

Other Inkbox group facts:

- Start a group: `POST /messages` with `to`: **2–8** E.164 numbers.
- `conversation_id` is the canonical key. Do not rebuild a thread from
  `participants`.
- `to` never adds/removes members. Membership changes happen in the
  native iMessage UI; Inkbox learns them from later activity.
- `participants` is append-only best-known history, not current roster.
- No V1 API to add/remove members.
- Inbound: `is_group: true`, `sender_number` = who spoke, `assignment_id`
  null, `remote_number` mirrors sender for compat.
- Read receipts and typing indicators → `409` on groups.
- Tapbacks work. Detaching the dedicated line freezes sends (`409`).
- New contacts on a dedicated line: 10/hour, 40/day.

### Sendblue

https://docs.sendblue.com/getting-started/groups/
https://www.sendblue.com/features/group-messaging

- Beta, plan-gated. Inbound-agent plans: **only reply after humans add
  the number** — the Tomo-like UX.
- Outbound create: `/api/send-group-message`, keep `group_id`.
- Modify: `/api/modify-group` `add_recipient` / `remove_recipient`.
- Remove needs ≥4 members (Apple). Up to 25 recipients on the marketing
  page. Rename supported. Leave is on the roadmap.

### Apple constraints (all providers)

https://support.apple.com/guide/iphone/iphb10c80fc5/ios

- Add to existing group: already ≥3 people, all iMessage.
- Cannot add a third person into a 1:1; start a new group.
- Mentions: type the contact name or `@name`.
- One non-iMessage member → downgrade / new thread.

---

## 5. What Bro should copy

Bro already sends a vCard and says «Карточку скинул — сохрани в контакты»
(`welcomeText` in `agent/lib/onboard-policy.ts`). That is the right
prerequisite. Groups are not handled in `agent/channels/imessage.ts`
(`is_group` does not appear).

### Product UX (copy this)

1. **Prerequisite: Bro is a named contact with a stable number.**
   Dedicated line, not the shared router. Landing / onboard: save the
   card (already done). Optional extra line: «Чтобы добавить Bro в чат
   с друзьями — Добавить контакт → Bro.»
2. **Join path = native iMessage Add, not a Bro-invented invite.**
   Teach it in help («что ты умеешь») in two bullets:
   - Существующая группа (уже 3+): иконка группы → Добавить → Bro.
   - Новый чат: написать другу и Bro в одно To:.
   No link, no `@bro` as the add target, no 1:1 “forward Bro into group”
   magic (Apple will not expand a 1:1).
3. **First bubble in a new group is consent + scope, no links if we
   ever *create* a group (Linq rule). Example:**
   «Я Bro, консьерж [имя]. Вижу этот чат. Пишите Bro / @Bro, когда
   нужна помощь. Личные карты и пароли сюда не кидать — это видят все.»
4. **Stay quiet unless addressed.** Classifier first
   (respond / react / ignore). Default ignore. Respond on mention,
   “бро/bro”, reply-to-Bro, or a clear ask after Bro just spoke.
   Tapback for «спасибо» / «лол». Never narrate every human message.
5. **Separate group session from 1:1.** New conversation id, new
   memory scope. Do not load vault, card, or private memo into a
   group turn. Owner = the bound tenant whose dedicated line is in
   the chat (the paying user). Other phones are participants, not
   extra tenants, unless they already have their own Bro.
6. **Billing / safety.** Group traffic counts on the owner’s meter.
   Unknown senders in the group do not get a new Bro identity.
   `sender_number` must be in the prompt as a name/handle.
7. **Do not copy Tomo’s hidden-ness.** If we ship it, put it on the
   landing, in welcome, and in help. Tomo hid it; Bro is a concierge
   friends will actually add for bookings and splits.

### Engineering gates (Inkbox)

1. Dedicated line on the identity (`BRO_DEDICATED_LINE`). Shared
   router will never see `is_group`.
2. Webhook: branch on `is_group`. Do not `upsertTenant` / bind a new
   person from a group sender.
3. Reply with `conversation_id`, never a reconstructed `to` list.
4. Skip typing indicators and read receipts on groups (409).
5. Tapbacks are fine (`imessage_react` already exists).
6. Optional later: Bro-created groups (`to` 2–8) for “соберу нас в чат
   с курьером” — that is Linq/Ditto-style, not Tomo’s consumer add flow.

### Out of scope / do not copy

- Open-source Tomo `/summon` / `groupSecret` / isolated CLI sessions.
- Linq “agent creates the group and sets a date-card icon” unless we
  explicitly build matchmaking/concierge *outbound* groups.
- Invite links (iMessage has none for this).
- SMS group fallback (Bro is blue-only).

---

## Source list

| Kind | URL | What it proves |
| --- | --- | --- |
| Official | https://tomo.ai/ | CTA “Text your Tomo”; no group copy |
| Official | https://tomo.ai/about | “Tomo can join group chats…”; no how-to; support email |
| Official | https://tomo.ai/privacy | Stores submitted content; no group clause |
| Official | https://tomo.ai/terms | Phone-number communications consent |
| Official | https://www.businesswire.com/news/home/20260625645270/en/Tomo-is-the-AI-Champion-Helping-People-Bet-on-Themselves-Emerging-from-Stealth-with-5-Million | “phone number you text”; “can join group chats” |
| Official-adjacent | https://linqapp.com/blog/tomo-customer-story | Tomo on Linq; single line; groups = hidden feature |
| Staff social | https://www.linkedin.com/posts/carson-packard_its-1-am-and-an-ai-is-texting-me-about-activity-7475946379899510784-CkGG | Public number +1 415 770 0115 |
| App Store | https://apps.apple.com/app/tomo-your-personal-ai/id6757726935 | iMessage + app; no groups |
| Infra | https://docs.linqapp.com/channel/imessage/guides/chats/group-chats/ | Linq group API |
| Infra | https://docs.linqapp.com/channel/imessage/guides/messaging/mentions/ | Mention send/receive |
| Infra | https://linqapp.com/blog/building-ai-agents-that-work-in-group-chats | respond/react/ignore gate |
| Infra | https://github.com/linq-team/ai-agent-example/ | Reference classifier |
| Infra | https://inkbox.ai/docs/api/imessage/groups | Bro’s provider; dedicated line only; 2–8; no member API |
| Infra | https://docs.sendblue.com/getting-started/groups/ | Inbound-only add-the-number model |
| Apple | https://support.apple.com/guide/iphone/iphb10c80fc5/ios | Add contact; mentions |

### Not Tomo.ai (ignore for product UX)

- https://github.com/shuaiyuan17/tomo and npm `tomo-ai` — self-hosted
  Claude agent with Telegram/iMessage via BlueBubbles.

---

## Confidence

| Claim | Confidence |
| --- | --- |
| Official copy says Tomo can join groups; no how-to | High (pages fetched) |
| Add = save number, native iMessage Add | High inference; no contradictory official flow |
| No invite link / special handle / in-app add | High (absence across official surfaces) |
| Public number +1 415 770 0115 | Medium-high (staff LinkedIn, not tomo.ai) |
| Groups still a low-discoverability feature | High as of Linq 2025; still no help page in 2026 |
| Tomo reply/mention/ownership rules | **Unpublished** — use Linq playbook as design default |
| Bro needs Inkbox dedicated line for groups | High (Inkbox docs) |
