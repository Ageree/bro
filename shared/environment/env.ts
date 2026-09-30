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

// The Cloud.ru and RouterAI keys reached the hosted environment not only with
// line breaks inside but wrapped in typographic quotes from a chat paste, and
// every call then failed with a 401 that named neither.
const pastedKeySchema = z
  .string()
  .transform((value) =>
    value.replaceAll(/\s+/gu, "").replaceAll(/^['"‘’“”]+|['"‘’“”]+$/gu, "")
  )
  .refine((value) => value.length > 0, "Required");

// `host:port:username:password`, the line a residential proxy provider hands
// out. The password is last because it is the only part that may hold a
// colon. `{session}` in the username is where the sticky-session token of one
// workspace goes (`agent/lib/browser-vm/proxy.ts`): a shared exit would let a
// site tie every person's errands together.
const browserVmProxySchema = z
  .string()
  .trim()
  .transform((value) => {
    const [host = "", port = "", username = "", ...password] = value.split(":");
    return {
      host,
      password: password.join(":"),
      port: Number(port),
      username,
    };
  })
  .pipe(
    z.object({
      host: z.string().min(1, "BROWSER_VM_PROXY needs a host"),
      password: z.string().min(1, "BROWSER_VM_PROXY needs a password"),
      port: z
        .number()
        .int("BROWSER_VM_PROXY needs a port number")
        .positive("BROWSER_VM_PROXY needs a port number")
        .max(65_535, "BROWSER_VM_PROXY needs a port number"),
      username: z
        .string()
        .refine(
          (value) => value.includes("{session}"),
          "BROWSER_VM_PROXY needs {session} in its username"
        ),
    })
  );

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
    // Where a browser errand runs when its workspace is not in a pilot list
    // below: Browser Use Cloud, the workspace's own Cloud.ru VM, or a gVisor
    // sandbox on a shared Cloud.ru host (`pool`, docs/browser-pool.md; see
    // `agent/lib/browser-vm/backend.ts`). The VM backend also needs every
    // CLOUDRU_* and BROWSER_VM_* value it lacks a default for; the pool needs
    // those of the VM backend but the image, and the BROWSER_STATE_*,
    // BROWSER_HOST_* and BROWSER_SANDBOX_ROOTFS values below.
    BROWSER_BACKEND: z
      .enum(["browser-use", "cloudru", "pool"])
      .default("browser-use"),
    // Hosts of the browser pool: Cloud.ru VMs from the stock Ubuntu image that
    // cloud-init sets up (`browser-vm/host/boot.py`). A host bills its flavor
    // by the hour while it lives, so one with no live sandbox for the idle
    // minutes is deleted (a stopped VM keeps its quota). At most
    // BROWSER_HOST_MAX live at once: the organization's quota is 8 vCPU and 2
    // public addresses. The bundle is the host code (`boot.py bundle`) in
    // BROWSER_STATE_BUCKET, as `<object key>:<sha256 of the bundle>`.
    BROWSER_HOST_BUNDLE: z
      .string()
      .trim()
      .transform((value, context) => {
        const groups = /^(?<key>\S+):(?<sha256>[\da-f]{64})$/u.exec(
          value
        )?.groups;
        if (groups?.key === undefined || groups.sha256 === undefined) {
          context.addIssue({
            code: "custom",
            message:
              "BROWSER_HOST_BUNDLE must be <object key>:<sha256 of the bundle>",
          });
          return z.NEVER;
        }
        return { key: groups.key, sha256: groups.sha256 };
      })
      .optional(),
    BROWSER_HOST_FLAVOR: trimmedValue.default("gen-4-16"),
    BROWSER_HOST_IDLE_MINUTES: z.coerce
      .number()
      .int("BROWSER_HOST_IDLE_MINUTES must be a whole number of minutes")
      .min(5, "BROWSER_HOST_IDLE_MINUTES must be at least 5")
      .max(1_440, "BROWSER_HOST_IDLE_MINUTES must be at most 1440")
      .default(60),
    BROWSER_HOST_MAX: z.coerce
      .number()
      .int("BROWSER_HOST_MAX must be a whole number")
      .min(1, "BROWSER_HOST_MAX must be at least 1")
      .max(16, "BROWSER_HOST_MAX must be at most 16")
      .default(1),
    // The dated gVisor release a host installs (`runscRelease` of boot.py): a
    // snapshot restores only under the runsc that made it, so it is pinned.
    BROWSER_HOST_RUNSC_RELEASE: z
      .string()
      .trim()
      .refine(
        (value) => /^\d{8}(?:\.\d+)?$/u.test(value),
        "BROWSER_HOST_RUNSC_RELEASE must be a dated gVisor release such as 20260914"
      )
      .optional(),
    // Workspace ids, or the emails of their owners, whose browser runs in a
    // sandbox of the pool whatever BROWSER_BACKEND says. They count as VM
    // workspaces everywhere else in Bro.
    BROWSER_POOL_WORKSPACES: z
      .string()
      .transform((value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      )
      .optional(),
    // The memory limit of one sandbox. A parked set is about this size, and a
    // snapshot restores only into a sandbox given at least as much.
    BROWSER_SANDBOX_MEMORY_MB: z.coerce
      .number()
      .int("BROWSER_SANDBOX_MEMORY_MB must be a whole number of megabytes")
      .min(1_024, "BROWSER_SANDBOX_MEMORY_MB must be at least 1024")
      .max(16_384, "BROWSER_SANDBOX_MEMORY_MB must be at most 16384")
      .default(3_072),
    // The sandbox root file system every host unpacks, as
    // `<version>:<object key>:<sha256 of the tarball>`: the version names the
    // directory on the host and goes into every snapshot's format; the
    // tarball lies in BROWSER_STATE_BUCKET.
    BROWSER_SANDBOX_ROOTFS: z
      .string()
      .trim()
      .transform((value, context) => {
        const groups =
          /^(?<version>[A-Za-z\d][\w.-]{0,63}):(?<key>\S+):(?<sha256>[\da-f]{64})$/u.exec(
            value
          )?.groups;
        if (
          groups?.version === undefined ||
          groups.key === undefined ||
          groups.sha256 === undefined
        ) {
          context.addIssue({
            code: "custom",
            message:
              "BROWSER_SANDBOX_ROOTFS must be <version>:<object key>:<sha256 of the tarball>",
          });
          return z.NEVER;
        }
        return {
          key: groups.key,
          sha256: groups.sha256,
          version: groups.version,
        };
      })
      .optional(),
    // Object Storage of the pool: parked sandboxes, the host bundle and the
    // sandbox root file system. The data key of a workspace's sets is derived
    // from BROWSER_STATE_KEY and the workspace id and never lies in S3.
    BROWSER_STATE_BUCKET: trimmedValue.optional(),
    BROWSER_STATE_KEY: z
      .string()
      .trim()
      .refine(
        (value) => /^(?:[\da-f]{2}){32,}$/iu.test(value),
        "BROWSER_STATE_KEY must be at least 32 bytes written in hex"
      )
      .optional(),
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
    // How often, in days, a site the person signed in to through an errand
    // is opened again with the same profile so its session stays fresh
    // (`agent/lib/browser-use/sign-ins.ts`). 0 turns the visits off.
    BROWSER_USE_SIGN_IN_REFRESH_DAYS: z.coerce
      .number()
      .int("BROWSER_USE_SIGN_IN_REFRESH_DAYS must be a whole number of days")
      .min(0, "BROWSER_USE_SIGN_IN_REFRESH_DAYS must be 0 or more")
      .max(30, "BROWSER_USE_SIGN_IN_REFRESH_DAYS must be at most 30")
      .default(3),
    BROWSER_USE_WEBHOOK_SECRET: requiredValue.optional(),
    // The agent model on the VM, reached through an OpenAI-compatible
    // provider that answers Russian addresses: OpenRouter, OpenAI and
    // Anthropic refuse Cloud.ru's with a 403.
    BROWSER_VM_LLM_API_KEY: pastedKeySchema.optional(),
    BROWSER_VM_LLM_BASE_URL: requiredValue
      .refine(
        (value) => URL.canParse(value),
        "BROWSER_VM_LLM_BASE_URL must be an absolute URL"
      )
      .default("https://routerai.ru/api/v1"),
    // A VM nobody used for this long is powered off: a stopped VM bills only
    // its disk, which keeps the person's sign-ins.
    BROWSER_VM_IDLE_MINUTES: z.coerce
      .number()
      .int("BROWSER_VM_IDLE_MINUTES must be a whole number of minutes")
      .min(3, "BROWSER_VM_IDLE_MINUTES must be at least 3")
      .max(240, "BROWSER_VM_IDLE_MINUTES must be at most 240")
      .default(20),
    // An errand nobody waits for — a schedule's, a background worker's, a
    // browser report's follow-up — stops its VM this long after its report
    // reached the conversation, unless a person's errand keeps it longer.
    BROWSER_VM_IDLE_BACKGROUND_MINUTES: z.coerce
      .number()
      .int(
        "BROWSER_VM_IDLE_BACKGROUND_MINUTES must be a whole number of minutes"
      )
      .min(1, "BROWSER_VM_IDLE_BACKGROUND_MINUTES must be at least 1")
      .max(240, "BROWSER_VM_IDLE_BACKGROUND_MINUTES must be at most 240")
      .default(2),
    // A run that stopped for the person's code or answer keeps its VM this
    // long after it settled: the page waits there for the reply.
    BROWSER_VM_IDLE_CODE_MINUTES: z.coerce
      .number()
      .int("BROWSER_VM_IDLE_CODE_MINUTES must be a whole number of minutes")
      .min(3, "BROWSER_VM_IDLE_CODE_MINUTES must be at least 3")
      .max(240, "BROWSER_VM_IDLE_CODE_MINUTES must be at most 240")
      .default(15),
    BROWSER_VM_MODEL: trimmedValue.default("deepseek/deepseek-v4.1-flash"),
    // What a gigabyte of the VM's residential proxy traffic costs, for the
    // cost accounting (`usage_costs`). Geonode bills about $0.27 a GB and up.
    BROWSER_VM_PROXY_RUB_PER_GB: z.coerce
      .number()
      .nonnegative("BROWSER_VM_PROXY_RUB_PER_GB must not be negative")
      .default(23),
    // 2Captcha, for a slider puzzle the VM's worker could not place itself:
    // it gets the puzzle and the page's address, nothing of the person.
    BROWSER_VM_TWOCAPTCHA_API_KEY: pastedKeySchema.optional(),
    BROWSER_VM_PROXY: browserVmProxySchema.optional(),
    // Each VM's worker key is derived from this one and the workspace id, so
    // the key a VM holds opens no other VM (`agent/lib/browser-vm/token.ts`).
    BROWSER_VM_SIGNING_KEY: z
      .string()
      .trim()
      .refine(
        (value) => /^(?:[\da-f]{2}){32,}$/iu.test(value),
        "BROWSER_VM_SIGNING_KEY must be at least 32 bytes written in hex"
      )
      .optional(),
    // The pilot: workspace ids, or the emails of their owners, that get a VM
    // whatever BROWSER_BACKEND says.
    BROWSER_VM_WORKSPACES: z
      .string()
      .transform((value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      )
      .optional(),
    // Cloud.ru Evolution, where the browser VMs live. The image is the one
    // `browser-vm/image/build.py` sealed; the security group is the one it
    // created. Without a project id the first project of the key's customer
    // is used.
    CLOUDRU_BROWSER_DISK_GB: z.coerce
      .number()
      .int("CLOUDRU_BROWSER_DISK_GB must be a whole number of gigabytes")
      .min(10, "CLOUDRU_BROWSER_DISK_GB must be at least the image's 10")
      .max(200, "CLOUDRU_BROWSER_DISK_GB must be at most 200")
      .default(12),
    CLOUDRU_BROWSER_FLAVOR: trimmedValue.default("gen-2-4"),
    CLOUDRU_BROWSER_IMAGE: trimmedValue.optional(),
    CLOUDRU_KEY_ID: pastedKeySchema.optional(),
    CLOUDRU_KEY_SECRET: pastedKeySchema.optional(),
    // The Object Storage tenant of the pool: the S3 access key is
    // `<CLOUDRU_S3_TENANT_ID>:<CLOUDRU_KEY_ID>`, its secret CLOUDRU_KEY_SECRET.
    CLOUDRU_S3_TENANT_ID: pastedKeySchema.optional(),
    CLOUDRU_PROJECT_ID: z
      .string()
      .trim()
      .pipe(z.guid("CLOUDRU_PROJECT_ID must be a project UUID"))
      .optional(),
    CLOUDRU_SECURITY_GROUP: trimmedValue.default("bro-browser"),
    CLOUDRU_SUBNET: trimmedValue.default("Default_ru.AZ-3"),
    CLOUDRU_ZONE: trimmedValue.default("ru.AZ-3"),
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
      "google/gemini-3.1-flash-lite-image"
    ),
    OPENROUTER_MANAGEMENT_KEY: openRouterApiKeySchema.optional(),
    // Caps what one model step may write, reasoning included. Left unset it
    // is 16,384 tokens, or 32,768 with reasoning on.
    OPENROUTER_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().optional(),
    OPENROUTER_MODEL: trimmedValue.default("deepseek/deepseek-v4.1-flash"),
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
      .default("low"),
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
    // The bearer token of the owner's cost report (`GET /api/usage-costs`).
    // Unset, the report does not exist.
    USAGE_REPORT_TOKEN: z
      .string()
      .trim()
      .min(32, "USAGE_REPORT_TOKEN must be at least 32 characters")
      .optional(),
    // Roubles per dollar for costs billed in dollars (OpenRouter, Browser Use
    // Cloud), converted when the cost is recorded.
    USAGE_USD_RUB: z.coerce
      .number()
      .positive("USAGE_USD_RUB must be greater than zero")
      .default(84.41),
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
