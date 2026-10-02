import { z } from "zod";
import {
  betterAuthSecretSchema,
  env,
  secretEncryptionKeySchema,
} from "@shared/environment";

const installationSecretsSchema = z.object({
  betterAuthSecret: betterAuthSecretSchema,
  secretEncryptionKey: secretEncryptionKeySchema,
});

/**
 * The secret that signs web sessions and the key the vault encrypts with.
 * Both come only from the environment: a deployment that made up its own
 * would sign everyone out and leave the vault unreadable. Local development
 * gets fixed defaults from `@shared/environment`.
 */
export function getInstallationSecrets() {
  const betterAuthSecret = env.BETTER_AUTH_SECRET;
  const secretEncryptionKey = env.SECRET_ENCRYPTION_KEY;
  if (!betterAuthSecret || !secretEncryptionKey) {
    throw new Error(
      "Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY: the session secret and the vault key are read only from the environment."
    );
  }
  return installationSecretsSchema.parse({
    betterAuthSecret,
    secretEncryptionKey,
  });
}
