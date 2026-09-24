import { and, eq, sql } from "drizzle-orm";
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
type Database = Pick<typeof db, "insert" | "select">;

async function readSetting(
  scope: AccessScope,
  key: SettingKey,
  database: Database = db
) {
  const rows = await database
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
  value: string,
  database: Database = db
) {
  await database
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
 * drops the chosen name. Changes are merged one at a time per workspace, so
 * «на вы» from one chat and a new name from another both stay. The lock is
 * on the workspace and key, since no row may exist yet to lock.
 */
export async function updateFormOfAddress(
  scope: AccessScope,
  change: Partial<FormOfAddress>
) {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${formOfAddressKey}:${scope.workspaceId}`}, 0))`
    );
    const current = parseFormOfAddress(
      await readSetting(scope, formOfAddressKey, transaction)
    );
    const next = formOfAddressSchema.parse({
      formal: change.formal ?? current.formal,
      name: change.name === undefined ? current.name : change.name,
    });
    await writeSetting(
      scope,
      formOfAddressKey,
      JSON.stringify(next),
      transaction
    );
    return next;
  });
}
