# P1 — Maritime REST-клиент + computer-policy + check

Контекст: Bro получает «компьютер на человека» на Maritime
(https://maritime.sh, REST `https://api.maritime.sh`, Bearer `mk_…` ключ в
`MARITIME_TOKEN`). Прочитай перед работой: `agent/subagents/worker/lib/kernel.ts`
(стиль клиента, хэш профиля без утечки телефона), `agent/lib/browseruse.ts`
(fetch-клиент к внешнему API), `scripts/worker-check.ts` (стиль check-скрипта),
спеку `docs/superpowers/specs/2026-09-01-bro-computer-maritime-design.md`.
Стиль: минимальный код, идиомы репо, `fetch` из Node 24, **без новых
зависимостей** (SDK `maritime-sdk` НЕ ставить). Не трогай `vendor/`,
`convex/`, `agent/subagents/`, `agent/tools/`, `agent/channels/`.

## Файлы (только эти)

- `agent/lib/computer-policy.ts` — новый, чистые функции, без IO.
- `agent/lib/maritime.ts` — новый, REST-клиент.
- `scripts/computer-check.ts` — новый.
- `package.json` — добавить script `"computer:check": "node --experimental-strip-types scripts/computer-check.ts"` рядом с `worker:check`.
- `.env.example`, `README.md` — секции ниже.

## Контракт `agent/lib/computer-policy.ts` (имена и сигнатуры точные — их импортируют P2/P3)

```ts
export type ComputerBackend = "off" | "maritime";
export const CHAT_WINDOW_MS = 30_000;          // окно синхронного /chat у Maritime
export const DEFAULT_TEMPLATE = "openclaw_browser";
export const POLL_INTERVAL_MINUTES = 2;

/** BRO_COMPUTER_BACKEND: "maritime" → maritime, всё остальное (undefined, "", мусор) → "off". */
export function computerBackend(raw?: string): ComputerBackend;
/** "bro:" + первые 40 hex sha256("maritime-computer\0" + phoneE164). Телефон не утекает. */
export function computerExternalId(phoneE164: string): string;
/** "bro-" + первые 12 hex того же digest. Имя агента в Maritime. */
export function computerAgentName(phoneE164: string): string;
/** BRO_COMPUTER_TEMPLATE или DEFAULT_TEMPLATE; trim; пустое → default. */
export function computerTemplate(raw?: string): string;
/** BRO_COMPUTER_DESKTOP === "1" | "true" (case-insensitive) → true. */
export function computerDesktopWanted(raw?: string): boolean;
/** Персона компьютера (RU). Обязательно: (1) он исполнитель веб-дел для Bro,
 *  отвечает коротко и по делу; (2) НИКОГДА не просит/не повторяет пароли, карты,
 *  коды, не вводит их в чат; (3) если нужен человек (CAPTCHA, 3-D Secure,
 *  подтверждение, логин) — отвечает строкой, начинающейся с
 *  "Нужен человек:" и держит браузер открытым; (4) если задача длиннее
 *  30 секунд — сразу отвечает строкой, начинающейся с "Работаю:" и продолжает
 *  в фоне, а результат отдаёт на следующий вопрос "статус". */
export function computerInstructions(): string;

export type ComputerStatus = "provisioning" | "ready" | "sleeping" | "error" | "unknown";
/** Maritime status → наш: deploying|building|pending|starting → provisioning; active|running → ready;
 *  sleeping|stopped → sleeping; error|errored|failed → error; иначе unknown. */
export function mapAgentStatus(status: string | null | undefined): ComputerStatus;

export type LiveView = { liveViewUrl: string | null; sessionId?: string | null; startedAt?: string | null; reason?: string | null };
/** url есть только при непустом liveViewUrl. hint (RU) — что сказать агенту:
 *  с url: «покажи ссылку человеку только если нужен takeover (CAPTCHA/3DS/подтверждение)»;
 *  без url: «сессии браузера сейчас нет, ссылку не обещай». */
export function liveViewDecision(view: LiveView): { url?: string; hint: string };

export type ChatOutcome = "done" | "working" | "blocked" | "empty";
/** null/undefined/"" → empty; начинается с "Работаю" (любой регистр) или elapsedMs >= CHAT_WINDOW_MS → working;
 *  "[blocked]" или начинается с "Нужен человек" → blocked; иначе done. */
export function chatOutcome(reply: string | null | undefined, elapsedMs: number): ChatOutcome;

/** true, если с startedAt прошло > 30 минут (как pollTimedOut в browser-policy). undefined → false. */
export function computerPollTimedOut(startedAt: number | undefined, now: number): boolean;
```

## Контракт `agent/lib/maritime.ts`

```ts
export class MaritimeError extends Error { status: number; code?: string; constructor(message: string, status: number, code?: string) }
export function maritimeEnabled(): boolean;                 // Boolean(process.env.MARITIME_TOKEN?.trim())
export function maritimeBaseUrl(): string;                  // MARITIME_API_URL?.trim() без хвостового "/" или "https://api.maritime.sh"
/** Для тестов: подменить fetch. По умолчанию globalThis.fetch. */
export function setMaritimeFetch(fn: typeof fetch | undefined): void;

export type MaritimeAgent = {
  id: string; name: string; status: string; externalId: string | null; framework: string;
  tier: string; desktopEnabled: boolean; projectId: string | null; publicUrl: string | null;
  lastActiveAt: string | null; idleTtlSeconds: number | null;
};
export type MaritimeLiveView = { liveViewUrl: string | null; sessionId: string | null; startedAt: string | null; reason: string | null };

export async function listAgents(opts?: { externalId?: string; signal?: AbortSignal }): Promise<MaritimeAgent[]>;   // GET /api/agents (+ ?externalId=) — фильтруй и на клиенте по externalId
export async function getAgent(id: string, signal?: AbortSignal): Promise<MaritimeAgent>;                           // GET /api/agents/{id}
export async function createAgent(body: {
  name: string; templateId: string; externalId: string; instructions?: string; description?: string;
  desktop?: boolean; idleTtlSeconds?: number; tier?: "smart" | "extended" | "always_on";
}, signal?: AbortSignal): Promise<MaritimeAgent>;                                                                   // POST /api/agents (201)
/** get-or-create по externalId: сначала listAgents({externalId}), иначе createAgent. created=true только при создании. */
export async function provisionAgent(args: Parameters<typeof createAgent>[0], signal?: AbortSignal): Promise<{ agent: MaritimeAgent; created: boolean }>;
export async function chat(id: string, message: string, opts?: { conversationId?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<{ response: string | null; error?: string }>; // POST /api/agents/{id}/chat, body {message, conversation_id?}; timeoutMs default 45_000 через AbortSignal.timeout + переданный signal
export async function liveView(id: string, signal?: AbortSignal): Promise<MaritimeLiveView>;                        // GET /api/agents/{id}/browser/live-view
export async function exec(id: string, command: string | string[], opts?: { timeout?: number; signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string }>; // POST /api/agents/{id}/exec
export async function listFiles(id: string, path?: string, signal?: AbortSignal): Promise<{ path: string; root: string; entries: { name: string; isDir: boolean; size: number; mtime: number }[] }>;
export async function writeFile(id: string, path: string, content: string, signal?: AbortSignal): Promise<void>;    // PUT /api/agents/{id}/files/write {path, content}
export async function setEnv(id: string, key: string, value: string, opts?: { secret?: boolean; reload?: boolean; signal?: AbortSignal }): Promise<void>; // POST /api/agents/{id}/env {key,value,isSecret}; reload → POST /reload-env
export async function startAgent(id: string, signal?: AbortSignal): Promise<void>;   // POST /start
export async function sleepAgent(id: string, signal?: AbortSignal): Promise<void>;   // POST /sleep
export async function deleteAgent(id: string, signal?: AbortSignal): Promise<void>;  // DELETE (204)
/** PATCH /api/agents/{id}/desktop-config {enabled}. 402 или code "seat_limit" → {ok:false, reason:"paid_plan_required"}. */
export async function setDesktop(id: string, enabled: boolean, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: "paid_plan_required" }>;
export async function planUsage(signal?: AbortSignal): Promise<{ plan: string; maxAgents: number | null; agents: number }>; // GET /api/wallet/plan-usage → {plan, limits.maxAgents, usage.agents}
export async function listTemplates(signal?: AbortSignal): Promise<{ id: string; name: string }[]>;                 // GET /api/templates (public)
```

Реализация: один приватный `request(method, path, {body?, signal?, timeoutMs?})`:
заголовки `Authorization: Bearer <MARITIME_TOKEN>` (без токена — `throw new
Error("MARITIME_TOKEN missing — компьютер недоступен на этом хосте")`),
`Accept: application/json`, `Content-Type` при body. Не-2xx → `MaritimeError`
с `status`, `code` из `body.code` и `message` из `body.detail` (строка) или
`body.error.message`. 204 → `undefined`. Ключ никогда не логируй.
Ответы Maritime в camelCase (`liveViewUrl`, `externalId`, `desktopEnabled`);
у `/api/agents` может прийти голый массив.

## `scripts/computer-check.ts`

Стиль `scripts/worker-check.ts` (`assert`/`throws`, в конце `console.log("computer ok")`).
Оффлайн asserts: B1–B4 из `.harness/goals/bro-computer/acceptance.md`, плюс
`mapAgentStatus`, `liveViewDecision`, `chatOutcome` (все ветки),
`computerPollTimedOut`, `computerInstructions()` содержит «Нужен человек:» и
«Работаю:», `maritimeBaseUrl()` без хвостового `/`. Для B3/B4 подмени
`process.env.MARITIME_TOKEN` (сохрани/восстанови как в worker-check) и
`setMaritimeFetch` фейком, который отдаёт `Response` с 402 и
`{"detail":"…","code":"seat_limit"}`; проверь `provisionAgent`
list→create (два вызова fetch, второй POST с `externalId`).

Live-часть только при `process.env.MARITIME_LIVE === "1"` и наличии токена:
`planUsage()`, `listTemplates()` содержит `openclaw_browser`; если
`listAgents({externalId:"spike:lead"})` непустой — `liveView(id)` возвращает
объект с полем `reason` или `liveViewUrl`. Ничего не создавать и не удалять.

## `.env.example` — добавить блок

```
# Maritime (компьютер на человека; https://maritime.sh). Ключ mk_… из `maritime keys create`.
# Без токена и без BRO_COMPUTER_BACKEND=maritime тул computer_task отвечает "off".
MARITIME_TOKEN=
# MARITIME_API_URL=https://api.maritime.sh
# BRO_COMPUTER_BACKEND=maritime
# BRO_COMPUTER_TEMPLATE=openclaw_browser
# Desktop (свой Linux-десктоп с takeover) требует платный план Maritime; 402 → без десктопа.
# BRO_COMPUTER_DESKTOP=0
```

## `README.md` — один абзац после абзаца про `worker`/Kernel

Кратко: что такое компьютер на Maritime (persistent microVM на человека,
Browserbase live view, desktop только на платном плане), флаг, что телефон в
Maritime не уходит, `npm run computer:check` (+ `MARITIME_LIVE=1`).

## Верификация

```bash
npm run -s types:check
npm run -s computer:check
npm run -s worker:check
```

НЕ запускай convex-команды, `eve build`, ничего не создавай в Maritime. НЕ коммить.
В конце — список файлов + вывод команд.
