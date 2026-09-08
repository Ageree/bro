export const BRO_COMPUTER_TTL_SECONDS = 900;
export const BRO_COMPUTER_START_RESERVE = 10;

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
