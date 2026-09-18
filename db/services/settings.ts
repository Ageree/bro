import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { defaultModelId } from "@shared/model/provider";
import { db, settings } from "@db";

// The stored key predates OpenRouter routing; it now holds whichever model id
// the active provider addresses.
const workspaceModelKey = "gateway_model";

async function readWorkspaceModelId(scope: AccessScope) {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.workspaceId, scope.workspaceId),
        eq(settings.key, workspaceModelKey)
      )
    )
    .limit(1);
  return rows[0]?.value;
}

export async function getWorkspaceModelId(scope: AccessScope) {
  return (await readWorkspaceModelId(scope)) ?? defaultModelId();
}

export async function selectWorkspaceModel(
  scope: AccessScope,
  modelId: string
) {
  await db
    .insert(settings)
    .values({
      key: workspaceModelKey,
      value: modelId,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      target: [settings.workspaceId, settings.key],
      set: { value: modelId },
    });
}
