export const BRO_COMPUTER_TTL_SECONDS = 900;
export const BRO_COMPUTER_START_RESERVE = 10;
export const DEFAULT_FREE_COMPUTER_STARTS_PER_DAY = 3;
export const DEFAULT_PAID_COMPUTER_STARTS_PER_DAY = 20;

export function computerStartAllowance(
  paid: boolean,
  env?: { free?: string; paid?: string },
): number {
  if (typeof paid !== "boolean") throw new Error("paid must be a boolean");
  const raw = paid ? env?.paid : env?.free;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error("computer start allowance must be a non-negative integer");
    }
    return n;
  }
  return paid
    ? DEFAULT_PAID_COMPUTER_STARTS_PER_DAY
    : DEFAULT_FREE_COMPUTER_STARTS_PER_DAY;
}

export type BoxState =
  | "init"
  | "provisioning"
  | "provisioned"
  | "cloning"
  | "ready"
  | "idle"
  | "running"
  | "archiving"
  | "archived"
  | "error";

export type CommandAction = "wait" | "command" | "resume" | "error";

export function nextCommandAction(state: BoxState): CommandAction {
  switch (state) {
    case "init":
    case "provisioning":
    case "provisioned":
    case "cloning":
    case "archiving":
      return "wait";
    case "ready":
    case "idle":
    case "running":
      return "command";
    case "archived":
      return "resume";
    case "error":
      return "error";
  }
}

export function shouldRenewTtl(
  archiveAfter: number | null | undefined,
  now: number,
  ttlSeconds = BRO_COMPUTER_TTL_SECONDS,
): boolean {
  if (archiveAfter == null) return true;
  return archiveAfter - now < (ttlSeconds / 2) * 1000;
}

export function canSpendStart(opts: {
  canStart: boolean;
  remaining?: number;
  reserve?: number;
}): boolean {
  if (!opts.canStart) return false;
  const reserve = opts.reserve ?? BRO_COMPUTER_START_RESERVE;
  if (typeof opts.remaining === "number" && opts.remaining < reserve) {
    return false;
  }
  return true;
}
