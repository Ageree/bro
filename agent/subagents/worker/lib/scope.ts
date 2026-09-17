/**
 * Tenant scope for worker tools.
 *
 * The tenant comes from the session principal that eve authenticated, never
 * from a model argument, so one person's browser and vault stay unreachable
 * from another person's session.
 */
import { getBrowserSession } from "../../../lib/convex";
import { tenantId } from "../../../lib/tenant";

type AuthBox = Parameters<typeof tenantId>[0];

export function workerTenant(ctx: AuthBox): string {
  return tenantId(ctx);
}

export async function requireOwnedBrowser(ctx: AuthBox, sessionId: string) {
  const phone = workerTenant(ctx);
  const session = await getBrowserSession(phone, sessionId);
  if (!session) {
    throw new Error(
      "браузер не найден среди сессий этого пользователя — создай новый через manage_browsers",
    );
  }
  return { phone, session };
}
