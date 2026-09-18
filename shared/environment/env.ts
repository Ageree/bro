import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { isE164PhoneNumber } from "@shared/identity/phone-number";
import { databaseUrlSchema } from "@shared/environment/database-url";

export const betterAuthSecretSchema = z
  .string()
  .refine(
    (value) => value.trim().length >= 32,
    "BETTER_AUTH_SECRET must contain at least 32 characters."
  );

export const secretEncryptionKeySchema = z
  .string()
  .refine(
    (value) => Buffer.from(value, "base64").length === 32,
    "SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key."
  );

const localDevelopment =
  process.env.NODE_ENV === "development" &&
  process.env.VERCEL_ENV === undefined;
const explicitBetterAuthSecret = hasValue(process.env.BETTER_AUTH_SECRET);
const explicitSecretEncryptionKey = hasValue(process.env.SECRET_ENCRYPTION_KEY);

if (
  localDevelopment &&
  explicitBetterAuthSecret !== explicitSecretEncryptionKey
) {
  throw new Error(
    "Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY, or leave both unset for local defaults."
  );
}

const useLocalInstallationDefaults =
  localDevelopment && !explicitBetterAuthSecret && !explicitSecretEncryptionKey;

const requiredValue = z
  .string()
  .refine((value) => value.trim().length > 0, "Required");

const betterAuthUrlSchema = requiredValue.refine(
  (value) => URL.canParse(value),
  "BETTER_AUTH_URL must be an absolute URL"
);

function optionalValueWithLocalDefault<T extends z.ZodType<string, string>>(
  schema: T,
  localDefault: z.util.NoUndefined<z.output<T>>
) {
  return localDevelopment ? schema.default(localDefault) : schema.optional();
}

function installationSecretWithLocalDefault<
  T extends z.ZodType<string, string>,
>(schema: T, localDefault: z.util.NoUndefined<z.output<T>>) {
  return useLocalInstallationDefaults
    ? schema.default(localDefault)
    : schema.optional();
}

/**
 * The hosted agent model Browser Use Cloud documents as the v4 default for
 * `POST /runs`. Overridden per deployment with `BROWSER_USE_MODEL`.
 */
const defaultBrowserUseModel = "gpt-5.6-luna";

// A Browser Use key carries no internal whitespace, so a newline that survived
// a paste into a hosted environment can only be damage: `fetch` rejects such a
// header value outright and every run fails with an error that points at the
// header instead of at the stored secret.
const browserUseApiKeySchema = z
  .string()
  .transform((value) => value.replaceAll(/\s+/gu, ""))
  .refine((value) => value.length > 0, "Required");

export const env = createEnv({
  server: {
    // Required
    DATABASE_URL: databaseUrlSchema,

    // Optional overrides with local defaults. Vercel deployments provision
    // installation secrets in their connected private Blob store.
    BETTER_AUTH_SECRET: installationSecretWithLocalDefault(
      betterAuthSecretSchema,
      "openinstinct-local-auth-development-secret"
    ),
    BETTER_AUTH_URL: optionalValueWithLocalDefault(
      betterAuthUrlSchema,
      "http://localhost:3000"
    ),
    SECRET_ENCRYPTION_KEY: installationSecretWithLocalDefault(
      secretEncryptionKeySchema,
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    ),

    // Optional
    BLOB_READ_WRITE_TOKEN: requiredValue.optional(),
    BLOB_STORE_ID: requiredValue.optional(),
    BROWSER_USE_API_KEY: browserUseApiKeySchema.optional(),
    BROWSER_USE_BASE_URL: requiredValue
      .refine(
        (value) => URL.canParse(value),
        "BROWSER_USE_BASE_URL must be an absolute URL"
      )
      .default("https://api.browser-use.com/api/v4"),
    BROWSER_USE_MODEL: requiredValue.default(defaultBrowserUseModel),
    BROWSER_USE_PROXY_COUNTRY: z
      .string()
      .trim()
      .toLowerCase()
      .refine(
        (value) => /^[a-z]{2}$/u.test(value),
        "BROWSER_USE_PROXY_COUNTRY must be an ISO 3166-1 alpha-2 code"
      )
      .default("ru"),
    BROWSER_USE_WEBHOOK_SECRET: requiredValue.optional(),
    GOOGLE_CONNECTOR_UID: requiredValue.default("google/open-instinct"),
    IMESSAGE_PHONE_NUMBER: requiredValue
      .refine(
        (value) => isE164PhoneNumber(value),
        "IMESSAGE_PHONE_NUMBER must use E.164 format"
      )
      .optional(),
    IMESSAGE_PROJECT_ID: requiredValue.optional(),
    IMESSAGE_PROJECT_SECRET: requiredValue.optional(),
    IMESSAGE_WEBHOOK_SECRET: requiredValue.optional(),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("production"),
    VERCEL_BRANCH_URL: requiredValue.optional(),
    VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
    VERCEL_PROJECT_ID: requiredValue.optional(),
    VERCEL_PROJECT_PRODUCTION_URL: requiredValue.optional(),
    VERCEL_URL: requiredValue.optional(),
  },
  experimental__runtimeEnv: {},
  emptyStringAsUndefined: true,
});

const authHostname = env.BETTER_AUTH_URL
  ? new URL(env.BETTER_AUTH_URL).hostname
  : undefined;

export const localPhoneAuthBypassEnabled =
  localDevelopment &&
  (authHostname === "localhost" ||
    authHostname?.endsWith(".localhost") === true ||
    authHostname === "127.0.0.1" ||
    authHostname === "[::1]");

function hasValue(value: string | undefined) {
  return value !== undefined && value.trim().length > 0;
}
