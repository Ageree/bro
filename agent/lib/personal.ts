import { requirePersonalPhone, tenantId } from "./tenant.ts";

type AuthBox = {
  session: {
    auth: {
      current?: { principalId?: string | null } | null;
      initiator?: { principalId?: string | null } | null;
    };
  };
};

export type PersonalDenied = {
  status: "denied";
  error: string;
};

/** Personal-only gate used by files, sandbox, and (until removed) computer tools. */
export function asPersonal(
  ctx: AuthBox,
): { phone: string } | PersonalDenied {
  try {
    return { phone: requirePersonalPhone(tenantId(ctx)) };
  } catch (err) {
    return {
      status: "denied",
      error:
        err instanceof Error ? err.message : "refusing shared principal",
    };
  }
}
