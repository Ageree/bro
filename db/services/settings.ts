import { and, eq } from "drizzle-orm";
import {
  defaultFormOfAddress,
  type FormOfAddress,
  formOfAddressSchema,
} from "@shared/chat/form-of-address";
import {
  defaultGoogleWorkspaceAccess,
  type GoogleWorkspaceAccess,
  googleWorkspaceAccessSchema,
} from "@shared/google-workspace/connection";
import type { AccessScope } from "@shared/identity/access-scope";
import { defaultModelId } from "@shared/model/provider";
import { db, settings } from "@db";

// The stored key predates OpenRouter routing; it now holds whichever model id
// the active provider addresses.
const workspaceModelKey = "gateway_model";
const googleWorkspaceAccessKey = "google_workspace_access";
const formOfAddressKey = "form_of_address";

type SettingKey = typeof settings.$inferInsert.key;

async function readSetting(scope: AccessScope, key: SettingKey) {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(eq(settings.workspaceId, scope.workspaceId), eq(settings.key, key))
    )
    .limit(1);
  return rows[0]?.value;
}

async function writeSetting(
  scope: AccessScope,
  key: SettingKey,
  value: string
) {
  await db
    .insert(settings)
    .values({ key, value, workspaceId: scope.workspaceId })
    .onConflictDoUpdate({
      target: [settings.workspaceId, settings.key],
      set: { value },
    });
}

export async function getWorkspaceModelId(scope: AccessScope) {
  return (await readSetting(scope, workspaceModelKey)) ?? defaultModelId();
}

export async function selectWorkspaceModel(
  scope: AccessScope,
  modelId: string
) {
  await writeSetting(scope, workspaceModelKey, modelId);
}

/**
 * The Google access level this workspace connects with. It is chosen when
 * the person starts the OAuth flow, so it names the scopes of the grant that
 * flow creates.
 */
export async function getGoogleWorkspaceAccess(
  scope: AccessScope
): Promise<GoogleWorkspaceAccess> {
  const stored = googleWorkspaceAccessSchema.safeParse(
    await readSetting(scope, googleWorkspaceAccessKey)
  );
  return stored.success ? stored.data : defaultGoogleWorkspaceAccess;
}

export async function selectGoogleWorkspaceAccess(
  scope: AccessScope,
  access: GoogleWorkspaceAccess
) {
  await writeSetting(scope, googleWorkspaceAccessKey, access);
}

function parseFormOfAddress(value: string | undefined) {
  if (value === undefined) return defaultFormOfAddress;
  try {
    const parsed = formOfAddressSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : defaultFormOfAddress;
  } catch {
    return defaultFormOfAddress;
  }
}

/**
 * How Bro addresses the person in every chat and channel of the workspace:
 * «ты» and no chosen name until they ask otherwise.
 */
export async function getFormOfAddress(
  scope: AccessScope
): Promise<FormOfAddress> {
  return parseFormOfAddress(await readSetting(scope, formOfAddressKey));
}

/**
 * Applies what the person asked to change and keeps the rest; `name: null`
 * drops the chosen name.
 */
export async function updateFormOfAddress(
  scope: AccessScope,
  change: Partial<FormOfAddress>
) {
  const current = await getFormOfAddress(scope);
  const next = formOfAddressSchema.parse({
    formal: change.formal ?? current.formal,
    name: change.name === undefined ? current.name : change.name,
  });
  await writeSetting(scope, formOfAddressKey, JSON.stringify(next));
  return next;
}
