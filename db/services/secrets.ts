import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { db, encryptedSecrets } from "@db";

export async function writeEncryptedSecret(
  scope: AccessScope,
  id: string,
  encryptedValue: string
) {
  const updatedAt = new Date();
  await db
    .insert(encryptedSecrets)
    .values({
      encryptedValue,
      id,
      namespace: "vault",
      updatedAt,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      target: [
        encryptedSecrets.workspaceId,
        encryptedSecrets.namespace,
        encryptedSecrets.id,
      ],
      set: { encryptedValue, updatedAt },
    });
}

export async function readEncryptedSecret(scope: AccessScope, id: string) {
  const rows = await db
    .select({ encryptedValue: encryptedSecrets.encryptedValue })
    .from(encryptedSecrets)
    .where(
      and(
        eq(encryptedSecrets.workspaceId, scope.workspaceId),
        eq(encryptedSecrets.namespace, "vault"),
        eq(encryptedSecrets.id, id)
      )
    )
    .limit(1);
  return rows[0]?.encryptedValue;
}

/** The ids of the workspace's stored secrets, in one query. */
export async function listEncryptedSecretIds(scope: AccessScope) {
  const rows = await db
    .select({ id: encryptedSecrets.id })
    .from(encryptedSecrets)
    .where(
      and(
        eq(encryptedSecrets.workspaceId, scope.workspaceId),
        eq(encryptedSecrets.namespace, "vault")
      )
    );
  return new Set(rows.map((row) => row.id));
}

export async function deleteEncryptedSecret(scope: AccessScope, id: string) {
  await db
    .delete(encryptedSecrets)
    .where(
      and(
        eq(encryptedSecrets.workspaceId, scope.workspaceId),
        eq(encryptedSecrets.namespace, "vault"),
        eq(encryptedSecrets.id, id)
      )
    );
}
