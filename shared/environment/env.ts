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

// Keys and ids pasted from a provider dashboard often carry stray whitespace.
const trimmedValue = z
  .string()
  .trim()
  .refine((value) => value.length > 0, "Required");

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

// An OpenRouter key is a bearer token with the same property, and the same
// failure mode when a pasted newline survives into the environment.
const openRouterApiKeySchema = browserUseApiKeySchema;

// A Composio project key goes out as a header as well.
const composioApiKeySchema = browserUseApiKeySchema;

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
    SUPERMEMORY_API_KEY: browserUseApiKeySchema.optional(),

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
    // Every run carries this ceiling, so a task that loops or wanders into an
    // expensive site stops costing money without anyone watching it.
    BROWSER_USE_MAX_COST_USD: z.coerce
      .number()
      .positive("BROWSER_USE_MAX_COST_USD must be greater than zero")
      .default(1),
    BROWSER_USE_MODEL: requiredValue.default(defaultBrowserUseModel),
    // A proxy of the deployment's own, for a shop whose wall knows the hosted
    // pool by sight. Browser Use takes it per run and never stores it, so all
    // four parts travel with every run this agent starts. Host and port are
    // what turn it on; an open proxy needs no credentials.
    BROWSER_USE_PROXY_HOST: requiredValue.optional(),
    BROWSER_USE_PROXY_PASSWORD: requiredValue.optional(),
    BROWSER_USE_PROXY_PORT: z.coerce
      .number()
      .int()
      .positive("BROWSER_USE_PROXY_PORT must be a port number")
      .max(65_535, "BROWSER_USE_PROXY_PORT must be a port number")
      .optional(),
    BROWSER_USE_PROXY_USERNAME: requiredValue.optional(),
    // How the proxy provider is asked for a different exit: a username with
    // `{session}` where a per-attempt token goes (sticky-session syntax such
    // as `user-session-{session}`). A background retry after an anti-bot wall
    // uses it; without it the retries alternate with the hosted pool instead.
    BROWSER_USE_PROXY_ROTATING_USERNAME: requiredValue
      .refine(
        (value) => value.includes("{session}"),
        "BROWSER_USE_PROXY_ROTATING_USERNAME must contain {session}"
      )
      .optional(),
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
    // Composio keeps each person's Google, Notion and Slack grants and calls
    // those APIs for Bro; without the key every integration is absent. The
    // auth config ids name the project's OAuth setups per app (see
    // docs/dev-notes.md); a read-only Google level without its own config
    // falls back to the full one and is held by Bro's own refusals.
    COMPOSIO_API_KEY: composioApiKeySchema.optional(),
    COMPOSIO_GOOGLE_AUTH_CONFIG_ID: trimmedValue.optional(),
    COMPOSIO_GOOGLE_READ_ONLY_AUTH_CONFIG_ID: trimmedValue.optional(),
    COMPOSIO_NOTION_AUTH_CONFIG_ID: trimmedValue.optional(),
    COMPOSIO_SLACK_AUTH_CONFIG_ID: trimmedValue.optional(),
    // Which Drizzle driver `db/index.ts` builds. Deployments keep the pooled
    // TCP client; `neon-http` exists for a maintenance run from a machine that
    // can only reach the database over HTTPS.
    DATABASE_DRIVER: z
      .enum(["node-postgres", "neon-http"])
      .default("node-postgres"),
    EVE_MEMORY_BLOB_READ_WRITE_TOKEN: requiredValue.optional(),
    EVE_MEMORY_BLOB_STORE_ID: requiredValue.optional(),
    // Usage ceilings per workspace: messages on the local day, browser errands
    // and drawn pictures on the local month. A deployment without YooKassa
    // keys never leaves the free column.
    FREE_BROWSER_RUNS_PER_MONTH: z.coerce.number().int().positive().default(5),
    FREE_IMAGE_GENERATIONS_PER_MONTH: z.coerce
      .number()
      .int()
      .positive()
      .default(10),
    FREE_MESSAGES_PER_DAY: z.coerce.number().int().positive().default(30),
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
    // OpenRouter replaces AI Gateway routing whenever its key is present.
    OPENROUTER_API_KEY: openRouterApiKeySchema.optional(),
    // The balance check alerts the owner below this many dollars of
    // OpenRouter credit. It needs OPENROUTER_MANAGEMENT_KEY, since the credits
    // endpoint refuses an inference key, and TELEGRAM_OWNER_CHAT_ID to reach
    // anyone.
    OPENROUTER_CREDITS_ALERT_USD: z.coerce
      .number()
      .positive("OPENROUTER_CREDITS_ALERT_USD must be greater than zero")
      .default(5),
    // `generate_image` draws and edits pictures through OpenRouter's Image API
    // with the same key; the model has to accept reference images.
    OPENROUTER_IMAGE_MODEL: trimmedValue.default(
      "google/gemini-3.1-flash-image"
    ),
    OPENROUTER_MANAGEMENT_KEY: openRouterApiKeySchema.optional(),
    OPENROUTER_MODEL: trimmedValue.default("openai/gpt-6-luna"),
    OPENROUTER_MODEL_CONTEXT_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .default(1_000_000),
    OPENROUTER_PROVIDER_ORDER: trimmedValue.optional(),
    // The `web_search` tool reads its plugin results with this model. Left
    // unset it reuses the inference default.
    OPENROUTER_SEARCH_MODEL: trimmedValue.optional(),
    OPENROUTER_REASONING_EFFORT: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(["off", "low", "medium", "high"]))
      .default("off"),
    // Inbound voice notes are transcribed through OpenRouter's audio endpoint
    // with the same key. The fallback model takes over when the first one
    // rejects the clip; the language is an ISO 639-1 hint, `auto` lets the
    // model guess.
    OPENROUTER_STT_FALLBACK_MODEL: trimmedValue.default(
      "openai/gpt-4o-transcribe"
    ),
    OPENROUTER_STT_LANGUAGE: trimmedValue.default("ru"),
    OPENROUTER_STT_MODEL: trimmedValue.default(
      "qwen/qwen3-asr-flash-2026-02-10"
    ),
    PAID_BROWSER_RUNS_PER_MONTH: z.coerce.number().int().positive().default(60),
    PAID_IMAGE_GENERATIONS_PER_MONTH: z.coerce
      .number()
      .int()
      .positive()
      .default(100),
    PAID_MESSAGES_PER_DAY: z.coerce.number().int().positive().default(500),
    // One month of paid access, in whole roubles.
    PRICE_RUB: z.coerce.number().int().positive().default(2000),
    TELEGRAM_BOT_TOKEN: requiredValue.optional(),
    TELEGRAM_BOT_USERNAME: requiredValue
      .refine(
        (value) => /^[A-Za-z0-9_]{5,32}$/u.test(value),
        "TELEGRAM_BOT_USERNAME must be the bot handle without a leading @"
      )
      .optional(),
    // The owner's own Telegram chat with the bot, where operational alerts
    // such as a running-out OpenRouter balance go.
    TELEGRAM_OWNER_CHAT_ID: z
      .string()
      .trim()
      .refine(
        (value) => /^-?\d+$/u.test(value),
        "TELEGRAM_OWNER_CHAT_ID must be a numeric Telegram chat id"
      )
      .optional(),
    TELEGRAM_WEBHOOK_SECRET_TOKEN: requiredValue.optional(),
    // Whether the FREE_*/PAID_* ceilings above and the paywall are enforced
    // at all. Off by default: the closed beta runs with no usage limits, by
    // the owner's decision. "on" restores the per-day/per-month ceilings and
    // the paywall.
    USAGE_LIMITS: z.enum(["on", "off"]).default("off"),
    VERCEL_BRANCH_URL: requiredValue.optional(),
    VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
    VERCEL_PROJECT_ID: requiredValue.optional(),
    VERCEL_PROJECT_PRODUCTION_URL: requiredValue.optional(),
    VERCEL_URL: requiredValue.optional(),
    // Both YooKassa credentials together switch billing on. With either one
    // missing the deployment runs in free mode: free limits, no pay link.
    YOOKASSA_SECRET_KEY: trimmedValue.optional(),
    YOOKASSA_SHOP_ID: trimmedValue.optional(),
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
