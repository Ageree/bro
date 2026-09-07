export type WaitingFor = "human" | "email" | "browser";

const DEFAULT_CHECK_IN_MINUTES: Record<WaitingFor, number> = {
  human: 20,
  email: 45,
  browser: 8,
};

export function defaultCheckInMinutes(waitingFor: WaitingFor): number {
  return DEFAULT_CHECK_IN_MINUTES[waitingFor];
}

export function shouldNudge(opts: {
  waitingFor: WaitingFor;
  waitingSince?: number;
  lastNudgeAt?: number;
  now: number;
}): boolean {
  if (opts.waitingSince == null) return false;
  const intervalMs = defaultCheckInMinutes(opts.waitingFor) * 60_000;
  if (opts.now - opts.waitingSince < intervalMs) return false;
  if (opts.lastNudgeAt != null && opts.now - opts.lastNudgeAt < intervalMs) {
    return false;
  }
  return true;
}

/** Human always speaks on a due nudge. Browser/email speak when that nudge is due. */
export function shouldSpeakNotSilent(waitingFor: WaitingFor): boolean {
  return (
    waitingFor === "human" ||
    waitingFor === "email" ||
    waitingFor === "browser"
  );
}

export function nudgePrompt(opts: {
  waitingFor: WaitingFor;
  goal: string;
  note?: string;
}): string {
  const extra = opts.note?.trim() ? ` ${opts.note.trim()}` : "";
  if (opts.waitingFor === "human") {
    return `Нужен твой ответ, чтобы продолжить: ${opts.goal}.${extra}`;
  }
  if (opts.waitingFor === "browser") {
    return `Bro всё ещё на этом (браузер / 3DS): ${opts.goal}.${extra}`;
  }
  return `Всё ещё жду письмо от клиники/почты: ${opts.goal}.${extra}`;
}
