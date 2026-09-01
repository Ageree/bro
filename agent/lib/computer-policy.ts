import { createHash } from "node:crypto";

export type ComputerBackend = "off" | "maritime";
export const CHAT_WINDOW_MS = 30_000;
export const DEFAULT_TEMPLATE = "openclaw_browser";
export const POLL_INTERVAL_MINUTES = 2;

const POLL_GIVE_UP_MS = 30 * 60_000;

export function computerBackend(raw?: string): ComputerBackend {
  return raw?.trim() === "maritime" ? "maritime" : "off";
}

function computerDigest(phoneE164: string): string {
  return createHash("sha256")
    .update(`maritime-computer\u0000${phoneE164}`)
    .digest("hex");
}

/** Phone never reaches Maritime — only this digest prefix. */
export function computerExternalId(phoneE164: string): string {
  return `bro:${computerDigest(phoneE164).slice(0, 40)}`;
}

export function computerAgentName(phoneE164: string): string {
  return `bro-${computerDigest(phoneE164).slice(0, 12)}`;
}

export function computerTemplate(raw?: string): string {
  const value = (raw ?? process.env.BRO_COMPUTER_TEMPLATE)?.trim();
  return value ? value : DEFAULT_TEMPLATE;
}

export function computerDesktopWanted(raw?: string): boolean {
  const value = (raw ?? process.env.BRO_COMPUTER_DESKTOP)?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function computerInstructions(): string {
  return [
    "Ты — исполнитель веб-дел для Bro. Отвечай коротко и по делу.",
    "Никогда не проси и не повторяй пароли, номера карт, CVV, коды из SMS или писем и не вводи их в чат.",
    "Если нужен человек (CAPTCHA, 3-D Secure, подтверждение, логин) — ответь строкой, которая начинается с «Нужен человек:», опиши что сделать, и держи браузер открытым.",
    "Если задача длиннее 30 секунд — сразу ответь строкой, которая начинается с «Работаю:», продолжай в фоне и отдай результат на следующий вопрос «статус».",
  ].join("\n");
}

export type ComputerStatus =
  | "provisioning"
  | "ready"
  | "sleeping"
  | "error"
  | "unknown";

const PROVISIONING = new Set(["deploying", "building", "pending", "starting"]);
const READY = new Set(["active", "running"]);
const SLEEPING = new Set(["sleeping", "stopped"]);
const ERROR = new Set(["error", "errored", "failed"]);

export function mapAgentStatus(
  status: string | null | undefined,
): ComputerStatus {
  const value = (status ?? "").trim().toLowerCase();
  if (PROVISIONING.has(value)) return "provisioning";
  if (READY.has(value)) return "ready";
  if (SLEEPING.has(value)) return "sleeping";
  if (ERROR.has(value)) return "error";
  return "unknown";
}

export type LiveView = {
  liveViewUrl: string | null;
  sessionId?: string | null;
  startedAt?: string | null;
  reason?: string | null;
};

export function liveViewDecision(view: LiveView): { url?: string; hint: string } {
  const url = view.liveViewUrl?.trim();
  if (url) {
    return {
      url,
      hint: "покажи ссылку человеку только если нужен takeover (CAPTCHA/3DS/подтверждение)",
    };
  }
  return { hint: "сессии браузера сейчас нет, ссылку не обещай" };
}

export type ChatOutcome = "done" | "working" | "blocked" | "empty";

export function chatOutcome(
  reply: string | null | undefined,
  elapsedMs: number,
): ChatOutcome {
  if (reply == null || reply === "") return "empty";
  const trimmed = reply.trim();
  // A blocker is a blocker even when the gateway took the whole window to say so.
  if (trimmed.startsWith("[blocked]") || trimmed.startsWith("Нужен человек")) {
    return "blocked";
  }
  if (
    trimmed.toLowerCase().startsWith("работаю") ||
    elapsedMs >= CHAT_WINDOW_MS
  ) {
    return "working";
  }
  return "done";
}

export function computerPollTimedOut(
  startedAt: number | undefined,
  now: number,
): boolean {
  if (startedAt === undefined) return false;
  return now - startedAt > POLL_GIVE_UP_MS;
}
