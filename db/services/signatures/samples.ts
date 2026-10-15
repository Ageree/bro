import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { db, personSignatures } from "@db";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { ensureScope } from "@db/services/scope";

/**
 * The person's signature sample (SIGN_WORKSPACES): the PNG cut from the photo
 * of their handwriting, or the name they typed for a handwriting font,
 * sealed with AES-256-GCM under the installation's key. The additional data
 * names the workspace, the user and the version, so a row copied to another
 * owner or another version does not open. The plaintext stays on the
 * server: it goes only into Bro's own sandbox for one signing, never into a
 * model, a tool result, a closure or a log.
 */

type SignatureSample =
  | { readonly kind: "image"; readonly png: Uint8Array }
  | { readonly kind: "typed"; readonly name: string };

function sampleAad(scope: AccessScope, id: string) {
  return Buffer.from(
    JSON.stringify(["signature", scope.workspaceId, scope.userId, id])
  );
}

async function seal(scope: AccessScope, id: string, plaintext: Uint8Array) {
  const { secretEncryptionKey } = await getInstallationSecrets();
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(secretEncryptionKey, "base64"),
    iv
  );
  cipher.setAAD(sampleAad(scope, id));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

async function unseal(scope: AccessScope, id: string, value: string) {
  const [version, iv, tag, ciphertext, ...rest] = value.split(".");
  if (
    version !== "v1" ||
    !iv ||
    !tag ||
    ciphertext === undefined ||
    rest.length > 0
  ) {
    throw new Error("The stored signature uses an unsupported format.");
  }
  const { secretEncryptionKey } = await getInstallationSecrets();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(secretEncryptionKey, "base64"),
    Buffer.from(iv, "base64url")
  );
  decipher.setAAD(sampleAad(scope, id));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]);
}

const ownSample = (scope: AccessScope) =>
  and(
    eq(personSignatures.workspaceId, scope.workspaceId),
    eq(personSignatures.userId, scope.userId)
  );

/**
 * Saves the sample, replacing the workspace's one: `id` is its new version
 * (a photo's sample keeps the id its signing was asked with).
 */
export async function saveSignatureSample(
  scope: AccessScope,
  sample: SignatureSample,
  id: string = randomUUID()
) {
  const encryptedValue = await seal(
    scope,
    id,
    sample.kind === "image" ? sample.png : Buffer.from(sample.name, "utf8")
  );
  const font = sample.kind === "typed" ? ("marck-script" as const) : null;
  await ensureScope(scope);
  const [before] = await db
    .select({ id: personSignatures.id })
    .from(personSignatures)
    .where(eq(personSignatures.workspaceId, scope.workspaceId))
    .limit(1);
  await db
    .insert(personSignatures)
    .values({
      encryptedValue,
      font,
      id,
      kind: sample.kind,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      target: personSignatures.workspaceId,
      set: {
        encryptedValue,
        font,
        id,
        kind: sample.kind,
        updatedAt: sql`now()`,
        userId: scope.userId,
      },
    });
  return { id, replaced: before !== undefined };
}

/** Which sample is saved and when, without opening it. */
export async function readSignatureSummary(scope: AccessScope) {
  const [row] = await db
    .select({
      id: personSignatures.id,
      kind: personSignatures.kind,
      savedAt: personSignatures.updatedAt,
    })
    .from(personSignatures)
    .where(ownSample(scope))
    .limit(1);
  return row ?? null;
}

/** The sample itself, for one signing in Bro's sandbox. */
export async function readSignatureSample(scope: AccessScope) {
  const [row] = await db
    .select()
    .from(personSignatures)
    .where(ownSample(scope))
    .limit(1);
  if (row === undefined) return null;
  const plaintext = await unseal(scope, row.id, row.encryptedValue);
  return row.kind === "image"
    ? { id: row.id, kind: "image" as const, png: new Uint8Array(plaintext) }
    : {
        font: "marck-script" as const,
        id: row.id,
        kind: "typed" as const,
        name: plaintext.toString("utf8"),
      };
}

/** Deletes the sample on the person's request; false when there was none. */
export async function deleteSignatureSample(scope: AccessScope) {
  const deleted = await db
    .delete(personSignatures)
    .where(ownSample(scope))
    .returning({ id: personSignatures.id });
  return deleted.length > 0;
}
