import { and, eq } from "drizzle-orm";
import { db, settings, workspaceMemberships } from "@db";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  browserAutonomyPolicySchema,
  type BrowserAutonomyPolicy,
  defaultBrowserAutonomyPolicy,
} from "@shared/browser/autonomy";

const browserAutonomyKey = "browser_autonomy";

async function hasWorkspaceMembership(scope: AccessScope) {
  const rows = await db
    .select({ userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, scope.workspaceId),
        eq(workspaceMemberships.userId, scope.userId)
      )
    )
    .limit(1);
  return rows.length === 1;
}

export async function getBrowserAutonomyPolicy(
  scope: AccessScope
): Promise<BrowserAutonomyPolicy> {
  if (!(await hasWorkspaceMembership(scope))) {
    return defaultBrowserAutonomyPolicy;
  }

  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.workspaceId, scope.workspaceId),
        eq(settings.key, browserAutonomyKey)
      )
    )
    .limit(1);
  const value = rows[0]?.value;
  if (!value) return defaultBrowserAutonomyPolicy;

  try {
    const parsed = browserAutonomyPolicySchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : defaultBrowserAutonomyPolicy;
  } catch {
    return defaultBrowserAutonomyPolicy;
  }
}

export async function setBrowserAutonomyPolicy(
  scope: AccessScope,
  policy: BrowserAutonomyPolicy
): Promise<void> {
  const validated = browserAutonomyPolicySchema.parse(policy);
  if (!(await hasWorkspaceMembership(scope))) {
    throw new Error("The authenticated user cannot change this workspace.");
  }

  await db
    .insert(settings)
    .values({
      key: browserAutonomyKey,
      value: JSON.stringify(validated),
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      target: [settings.workspaceId, settings.key],
      set: { value: JSON.stringify(validated) },
    });
}
