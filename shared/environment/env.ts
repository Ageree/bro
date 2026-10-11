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

// A pilot list: workspace ids, or the emails of their owners, separated by
// commas (`agent/lib/workspace-list.ts`).
const workspaceListSchema = z.string().transform((value) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
);

/**
 * An object of BROWSER_STATE_BUCKET pinned by version and checksum, as
 * `<version>:<object key>:<sha256 of the object>`.
 */
function versionedObjectSchema(name: string, object: string) {
  return z
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
          message: `${name} must be <version>:<object key>:<sha256 of ${object}>`,
        });
        return z.NEVER;
      }
      return {
        key: groups.key,
        sha256: groups.sha256,
        version: groups.version,
      };
    });
}

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

// The address every presigned URL of Object Storage is built on, so a path,
// a query or a login in it would end up in the signed string.
const s3EndpointSchema = z
  .string()
  .trim()
  .refine((value) => {
    const url = URL.parse(value);
    return (
      url?.protocol === "https:" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  }, "S3_ENDPOINT must be an absolute https URL without a path")
  .transform((value) => new URL(value).origin);

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
    PHONE_AUTO_PROVISION: z.enum(["on", "off"]).default("off"),
    PHONE_WORKSPACES: workspaceListSchema.optional(),
    PHONE_INIT_SECRET: trimmedValue.min(32).optional(),
    PHONE_WEBHOOK_SECRET: trimmedValue.min(32).optional(),
    MTS_EXOLVE_API_KEY: trimmedValue.optional(),
    ELEVENLABS_API_KEY: trimmedValue.optional(),
    ELEVENLABS_PROXY_URL: z
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        "ELEVENLABS_PROXY_URL must be an HTTP or HTTPS proxy URL"
      )
      .optional(),
    PHONE_AGENT_ID: trimmedValue.optional(),
    PHONE_MAX_ACTIVE_NUMBERS: z.coerce.number().int().positive().optional(),
    PHONE_MAX_SETUP_RUB: z.coerce.number().int().min(0).max(1000).default(600),
    PHONE_MAX_MONTHLY_RUB: z.coerce.number().int().min(0).max(500).default(155),
    PHONE_MAX_SIP_MONTHLY_RUB: z.coerce
      .number()
      .int()
      .min(0)
      .max(95)
      .default(0),
    AGENTMAIL_API_KEY: trimmedValue.optional(),
    AGENTMAIL_PROXY_URL: z
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        "AGENTMAIL_PROXY_URL must be an HTTP or HTTPS proxy URL"
      )
      .optional(),
    // Unset or empty (or `*`), every workspace gets a mailbox once
    // AGENTMAIL_API_KEY is set; `off` switches AgentMail off for all (the way
    // back); a list of workspace ids narrows it to those.
    AGENTMAIL_WORKSPACES: workspaceListSchema.optional(),
    // Required
    DATABASE_URL: databaseUrlSchema,

    // Optional overrides with local defaults. Without them a Vercel
    // deployment reads the installation secrets from its connected private
    // Blob store (`db/services/installation-secrets.ts`); off Vercel set both,
    // with the values from that store.
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
    // below: Browser Use Cloud, the workspace's own Cloud.ru VM, or a
    // sandbox on a shared Cloud.ru host (`pool`, docs/browser-pool.md; see
    // `agent/lib/browser-vm/backend.ts`). The VM backend also needs every
    // CLOUDRU_* and BROWSER_VM_* value it lacks a default for; the pool needs
    // those of the VM backend but the image, and the BROWSER_STATE_*,
    // BROWSER_HOST_* and BROWSER_SANDBOX_ROOTFS values below.
    BROWSER_BACKEND: z
      .enum(["browser-use", "cloudru", "pool"])
      .default("browser-use"),
    // The pilot of the fast browser: workspace ids or owners' emails, or `*`
    // for every workspace, whose errands on their own browser have DeepSeek
    // served by Together first (three times DeepInfra's speed on 05.10, at
    // twice its price), give up on a model call stuck past 25 s, and run in
    // flash mode when they only search (`agent/lib/browser-vm/pilot.ts`,
    // docs/browser-speed.md). Unset, every errand runs as before.
    BROWSER_FAST_WORKSPACES: workspaceListSchema.optional(),
    // Who may get the sign-in link, where the person signs in to a site
    // themselves in a live view of their own cloud browser
    // (`agent/lib/login-handoff/`, docs/login-handoff.md). Unset or empty,
    // every workspace; `off` switches it off for all (the way back); a list of
    // workspace ids or owners' emails narrows it to those. The link also
    // needs the workspace's browser to be a pool sandbox (BROWSER_BACKEND).
    LOGIN_HANDOFF_WORKSPACES: workspaceListSchema.optional(),
    // The pilot of the Yandex tool (`yandex`, `agent/lib/yandex/`): workspace
    // ids, or `*`, whose Bro calls Yandex services (Market, Food…) from a tab
    // of its own pool browser, signed in as the person. Unset, nobody.
    YANDEX_API_WORKSPACES: workspaceListSchema
      .refine(
        (entries) => entries.every((entry) => !entry.includes("@")),
        "YANDEX_API_WORKSPACES takes workspace ids or *, not emails"
      )
      .optional(),
    YANDEX_PURCHASE_WORKSPACES: workspaceListSchema
      .refine(
        (entries) => entries.every((entry) => !entry.includes("@")),
        "YANDEX_PURCHASE_WORKSPACES takes workspace ids or *, not emails"
      )
      .optional(),
    BROWSER_VM_FILES_WORKSPACES: workspaceListSchema
      .refine(
        (entries) => entries.every((entry) => !entry.includes("@")),
        "BROWSER_VM_FILES_WORKSPACES takes workspace ids or *, not emails"
      )
      .optional(),
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
    // Hosts on the current bundle, root and runtime the pool keeps in service
    // however long they stay empty (docs/browser-pool.md, «Сон хоста»): an
    // errand then starts its sandbox in seconds instead of waiting a minute
    // and a half for a sleeping host or five for a new one. Each one bills
    // its flavor by the hour (gen-2-8: 5.50 ₽, about 3 960 ₽ a month). At
    // most BROWSER_HOST_MAX count; 0 keeps none, as before this setting.
    BROWSER_HOST_MIN_WARM: z.coerce
      .number()
      .int("BROWSER_HOST_MIN_WARM must be a whole number")
      .min(0, "BROWSER_HOST_MIN_WARM must be at least 0")
      .max(16, "BROWSER_HOST_MIN_WARM must be at most 16")
      .default(0),
    // The hours, Moscow time, during which BROWSER_HOST_MIN_WARM holds, as
    // `HH-HH`: from the first hour up to the second, past midnight when the
    // second is smaller (`08-02` is 08:00–02:00). Unset: all day.
    BROWSER_HOST_WARM_HOURS: z
      .string()
      .trim()
      .transform((value, context) => {
        const groups = /^(?<from>\d{2})-(?<to>\d{2})$/u.exec(value)?.groups;
        const from = Number(groups?.from);
        const to = Number(groups?.to);
        if (
          !Number.isInteger(from) ||
          !Number.isInteger(to) ||
          from > 23 ||
          to > 23 ||
          from === to
        ) {
          context.addIssue({
            code: "custom",
            message:
              "BROWSER_HOST_WARM_HOURS must be two different hours HH-HH (00–23), such as 08-02",
          });
          return z.NEVER;
        }
        return { from, to };
      })
      .optional(),
    // Host ids and VM names are this prefix and the slot number
    // (`bro-host-1`…): a test stand takes another prefix, so its hosts and
    // Bro's never share a name, a token key or a record.
    BROWSER_HOST_NAME_PREFIX: z
      .string()
      .trim()
      .refine(
        (value) => /^[a-z][a-z\d-]{0,55}$/u.test(value),
        "BROWSER_HOST_NAME_PREFIX must be lower-case letters, digits and dashes, such as bro-host-"
      )
      .default("bro-host-"),
    // How a host runs its sandboxes (`runtime` of boot.py): plain containers
    // (`runc`, profile-only sets), or gVisor with memory snapshots (`runsc`),
    // which also needs BROWSER_HOST_RUNSC_RELEASE, or Firecracker microVMs
    // (`firecracker`, snapshots kept on the host). No default: unset, a
    // deployment with BROWSER_HOST_RUNSC_RELEASE runs runsc as it did before
    // this setting, and one without it has no pool (`browserPoolConfigured`).
    BROWSER_HOST_RUNTIME: z.enum(["runc", "runsc", "firecracker"]).optional(),
    // The dated gVisor release a host installs under `runsc`
    // (`runscRelease` of boot.py): a snapshot restores only under the runsc
    // that made it, so it is pinned. Not used under `runc`.
    BROWSER_HOST_RUNSC_RELEASE: z
      .string()
      .trim()
      .refine(
        (value) => /^\d{8}(?:\.\d+)?$/u.test(value),
        "BROWSER_HOST_RUNSC_RELEASE must be a dated gVisor release such as 20260914"
      )
      .optional(),
    // Where the pool's hosts come from. `cloudru` (the default): Bro creates,
    // powers off and deletes Cloud.ru VMs. `static`: the hosts are servers an
    // operator provisioned once (cloud-init from
    // scripts/browser-pool/static-host-cloud-init.ts) and listed in
    // BROWSER_HOST_STATIC; Bro never creates, powers, reboots or deletes
    // anything for them, and they are always on.
    BROWSER_HOST_CLOUD: z.enum(["cloudru", "static"]).default("cloudru"),
    // `<host id>@<public IPv4>`, comma-separated: the hosts of the `static`
    // pool. A host id matches [a-z0-9-]{1,63} (it is also the host's identity
    // in its token key).
    BROWSER_HOST_STATIC: z
      .string()
      .transform((value, context) => {
        const hosts: { id: string; address: string }[] = [];
        for (const entry of value.split(",")) {
          const text = entry.trim();
          if (text.length === 0) continue;
          const [id, address, ...rest] = text.split("@");
          if (
            id === undefined ||
            address === undefined ||
            rest.length > 0 ||
            !/^[a-z\d-]{1,63}$/u.test(id) ||
            !z.ipv4().safeParse(address).success
          ) {
            context.addIssue({
              code: "custom",
              message: `BROWSER_HOST_STATIC entry "${text}" must be <host id>@<public IPv4>, the id matching [a-z0-9-]{1,63}`,
            });
            return z.NEVER;
          }
          if (
            hosts.some((host) => host.id === id || host.address === address)
          ) {
            context.addIssue({
              code: "custom",
              message: `BROWSER_HOST_STATIC lists "${text}" twice`,
            });
            return z.NEVER;
          }
          hosts.push({ address, id });
        }
        if (hosts.length === 0) {
          context.addIssue({
            code: "custom",
            message: "BROWSER_HOST_STATIC must list at least one host",
          });
          return z.NEVER;
        }
        return hosts;
      })
      .optional(),
    // Workspace ids, or the emails of their owners, whose browser runs in a
    // sandbox of the pool whatever BROWSER_BACKEND says. They count as VM
    // workspaces everywhere else in Bro.
    BROWSER_POOL_WORKSPACES: workspaceListSchema.optional(),
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
    BROWSER_SANDBOX_ROOTFS: versionedObjectSchema(
      "BROWSER_SANDBOX_ROOTFS",
      "the tarball"
    ).optional(),
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
    // The worker code Bro rolls out to workspaces' own VMs (not to sandboxes
    // of the pool, whose worker comes with the root file system), as
    // `<version>:<object key>:<sha256 of worker.py>`; the file lies in
    // BROWSER_STATE_BUCKET (`browser-vm/worker/publish.py` prints the value).
    // A VM whose worker reports an older version gets it before an errand
    // (`agent/lib/browser-vm/rollout.ts`). Unset, nothing is rolled out.
    BROWSER_VM_WORKER: versionedObjectSchema(
      "BROWSER_VM_WORKER",
      "worker.py"
    ).optional(),
    // The pilot: workspace ids, or the emails of their owners, that get a VM
    // whatever BROWSER_BACKEND says.
    BROWSER_VM_WORKSPACES: workspaceListSchema.optional(),
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
    // Cloud.ru Foundation Models, the OpenAI-compatible API inside the cloud
    // that answers RouterAI's chat calls while the route to RouterAI is down
    // (`agent/lib/model/routerai/fallback.ts`). Its own API key, not the IAM
    // key below; without it nothing falls back.
    CLOUDRU_FM_API_KEY: pastedKeySchema.optional(),
    // The key goes to this address with every call: https only.
    CLOUDRU_FM_BASE_URL: requiredValue
      .refine(
        (value) => URL.parse(value)?.protocol === "https:",
        "CLOUDRU_FM_BASE_URL must be an absolute https URL"
      )
      .default("https://foundation-models.api.cloud.ru/v1"),
    CLOUDRU_FM_MODEL: trimmedValue.default("deepseek-ai/DeepSeek-V4.1-Flash"),
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
    // `on` where Bro itself runs on a Cloud.ru VM: its calls to the
    // project's VMs by their `<public IP>.sslip.io` names dial their private
    // addresses, since no VM of the project reaches another's public one
    // (`agent/lib/browser-vm/private-route.ts`). Off on Vercel.
    CLOUDRU_PRIVATE_ROUTING: z.enum(["on", "off"]).default("off"),
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
    MAILRU_MAIL_CLIENT_ID: trimmedValue.optional(),
    MAILRU_MAIL_CLIENT_SECRET: trimmedValue.optional(),
    YANDEX_MAIL_CLIENT_ID: trimmedValue.optional(),
    YANDEX_MAIL_CLIENT_SECRET: trimmedValue.optional(),
    MAIL_WORKSPACES: workspaceListSchema.optional(),
    // Which Drizzle driver `db/index.ts` builds. Deployments keep the pooled
    // TCP client; `neon-http` exists for a maintenance run from a machine that
    // can only reach the database over HTTPS.
    DATABASE_DRIVER: z
      .enum(["node-postgres", "neon-http"])
      .default("node-postgres"),
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
    // Where Bro's own model calls go: `routerai` or `openrouter`, each with
    // its key below. Left unset, an OpenRouter key alone selects OpenRouter
    // and no key at all leaves the Vercel AI Gateway
    // (`shared/model/provider.ts`).
    MODEL_PROVIDER: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(["openrouter", "routerai"]))
      .optional(),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("production"),
    // OpenRouter replaces AI Gateway routing whenever its key is present and
    // MODEL_PROVIDER names no other provider.
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
    // RouterAI (routerai.ru), the OpenRouter-compatible reseller that
    // answers from Russia, selected by MODEL_PROVIDER=routerai. Its prices
    // and `usage.cost` are in roubles. The key and every knob below are its
    // own, apart from the OPENROUTER_* ones, so switching back is one
    // variable (`agent/lib/model/endpoint.ts`).
    ROUTERAI_API_KEY: pastedKeySchema.optional(),
    // The key goes to this address with every call: https only.
    ROUTERAI_BASE_URL: requiredValue
      .refine(
        (value) => URL.parse(value)?.protocol === "https:",
        "ROUTERAI_BASE_URL must be an absolute https URL"
      )
      .default("https://routerai.ru/api/v1"),
    // The balance check alerts the owner below this many roubles; RouterAI's
    // `/credits` takes the ordinary key.
    ROUTERAI_CREDITS_ALERT_RUB: z.coerce
      .number()
      .positive("ROUTERAI_CREDITS_ALERT_RUB must be greater than zero")
      .default(300),
    ROUTERAI_IMAGE_MODEL: trimmedValue.default(
      "google/gemini-3.1-flash-lite-image"
    ),
    // Caps what one model step may write, reasoning included. Left unset it
    // is 16,384 tokens, or 32,768 with reasoning on.
    ROUTERAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().optional(),
    ROUTERAI_MODEL: trimmedValue.default("deepseek/deepseek-v4.1-flash"),
    ROUTERAI_MODEL_CONTEXT_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .default(1_048_576),
    // Upstream hosts, comma-separated. The order pins hosts for every model
    // (unset, a DeepSeek model gets hosts that hold the prompt cache); the
    // ignore list skips hosts on top of the ones the code always skips.
    ROUTERAI_PROVIDER_IGNORE: trimmedValue.optional(),
    ROUTERAI_PROVIDER_ORDER: trimmedValue.optional(),
    ROUTERAI_REASONING_EFFORT: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(["off", "low", "medium", "high"]))
      .default("low"),
    // `web_search` reads its plugin results with this model, unset the
    // inference default, and asks the search engine for this many pages.
    ROUTERAI_SEARCH_MAX_RESULTS: z.coerce
      .number()
      .int("ROUTERAI_SEARCH_MAX_RESULTS must be a whole number")
      .min(1, "ROUTERAI_SEARCH_MAX_RESULTS must be at least 1")
      .max(10, "ROUTERAI_SEARCH_MAX_RESULTS must be at most 10")
      .default(5),
    ROUTERAI_SEARCH_MODEL: trimmedValue.optional(),
    // Voice notes go to RouterAI's `/audio/transcriptions`; the fallback
    // model takes over when the first one rejects the clip, and the language
    // is an ISO 639-1 hint, `auto` lets the model guess.
    ROUTERAI_STT_FALLBACK_MODEL: trimmedValue.default(
      "openai/whisper-large-v3-turbo"
    ),
    ROUTERAI_STT_LANGUAGE: trimmedValue.default("ru"),
    ROUTERAI_STT_MODEL: trimmedValue.default("qwen/qwen3-asr-flash-2026-02-10"),
    // Object Storage of any S3-compatible provider (Selectel, say): the four
    // go together or not at all. With them Bro signs for this endpoint with
    // this plain access key, in BROWSER_STATE_BUCKET; without them it uses
    // Cloud.ru's (`https://s3.cloud.ru`, `ru-central-1`, the key
    // `<CLOUDRU_S3_TENANT_ID>:<CLOUDRU_KEY_ID>`). The endpoint is an https
    // origin without a path, and the region is the one the provider signs
    // for (Selectel: `ru-1`, `https://s3.ru-1.storage.selcloud.ru`).
    S3_ACCESS_KEY_ID: pastedKeySchema.optional(),
    S3_ENDPOINT: s3EndpointSchema.optional(),
    S3_REGION: trimmedValue.optional(),
    S3_SECRET_ACCESS_KEY: pastedKeySchema.optional(),
    // Where Bro's own sandbox runs, the one eve keeps people's photos, voice
    // messages and documents in (`agent/sandbox.ts`): `default` is eve's
    // choice (Vercel Sandbox on Vercel), `bro-cloudru` the code sandbox host
    // below. Changing it starts every session's sandbox afresh.
    AGENT_SANDBOX: z.enum(["default", "bro-cloudru"]).default("default"),
    // The code sandbox host on Cloud.ru (`sandbox/README.md`): its id, its
    // HTTPS origin (`https://<address with dashes>.sslip.io`), and the key
    // its token key and the sandbox tool router's token key are derived from
    // (`agent/lib/sandbox/keys.ts`). All three together switch the task
    // agent's sandbox on.
    SANDBOX_HOST_ID: z
      .string()
      .trim()
      .refine(
        (value) => /^[a-z0-9-]{1,63}$/u.test(value),
        "SANDBOX_HOST_ID must be 1 to 63 lower-case letters, digits or dashes"
      )
      .optional(),
    SANDBOX_HOST_ORIGIN: z
      .string()
      .trim()
      .refine((value) => {
        // An origin only: the client appends `/v1/sandboxes/…` to it.
        const url = URL.parse(value);
        return (
          url?.protocol === "https:" &&
          url.username === "" &&
          url.password === "" &&
          url.pathname === "/" &&
          url.search === "" &&
          url.hash === ""
        );
      }, "SANDBOX_HOST_ORIGIN must be an https origin, without a path or query")
      .transform((value) => value.replace(/\/+$/u, ""))
      .optional(),
    SANDBOX_SIGNING_KEY: z
      .string()
      .trim()
      .refine(
        (value) => /^(?:[\da-f]{2}){32,}$/iu.test(value),
        "SANDBOX_SIGNING_KEY must be at least 32 bytes written in hex"
      )
      .optional(),
    // Where `sandboxd` sends the sandbox's tool calls; unset, this
    // deployment's own `/api/sandbox/graphql`.
    SANDBOX_TOOLS_URL: z
      .string()
      .trim()
      .refine(
        (value) => URL.parse(value)?.protocol === "https:",
        "SANDBOX_TOOLS_URL must be an https URL"
      )
      .optional(),
    // The pilot of the task agent and its sandbox: workspace ids or owners'
    // emails, or `*` for every workspace.
    SANDBOX_WORKSPACES: workspaceListSchema.optional(),
    // Whether this deployment runs eve's schedules (`agent/schedules`). "off"
    // on a rehearsal stand: its ticks would poll errands, check mail and
    // write to people from a copy of production's data, and only one
    // scheduler may run per database (docs/cloudru-migration.md). "browser"
    // runs only the browser errands' tick, so a stand can carry an errand of
    // its own through the pool (docs/selectel-migration.md).
    EVE_SCHEDULES: z.enum(["on", "off", "browser"]).default("on"),
    // The pilot of the daily memory digest (docs/memory.md): workspace ids or
    // owners' emails, or `*` for every workspace, whose memory the digest
    // cleans (codes cut out, duplicates folded, history trimmed). Unset, the
    // digest runs for no one: it changes what people saved.
    MEMORY_DIGEST_WORKSPACES: workspaceListSchema.optional(),
    // The model the pilot's daily memory digest asks which memories are
    // one-off, duplicates or corrected, through the same direct provider;
    // unset, `deepseek/deepseek-v4-flash` (agent/lib/memory/digest/
    // classifier.ts) — never the main agent's or the workspace's model.
    MEMORY_DIGEST_MODEL: trimmedValue.optional(),
    // The pilot of skills chosen by the server (docs/roadmap.md, item 24):
    // workspace ids, or `*` for every workspace, whose interactive turns get
    // the core instructions and a skill's rules only when the turn needs
    // them (`agent/lib/skills/`). No owners' emails: the instructions, the
    // `skills` memory slot and `load_skill` must reach the same verdict
    // without a lookup. Only with the direct model (RouterAI or OpenRouter).
    // Independent of STEP_CONTEXT_WORKSPACES, but it pays off with it: without
    // it the clock in the instructions puts the index and every attached
    // block at full price on every step (scripts/costs/step-context.ts).
    SKILLS_WORKSPACES: workspaceListSchema
      .refine(
        (entries) => entries.every((entry) => !entry.includes("@")),
        "SKILLS_WORKSPACES takes workspace ids or *, not emails"
      )
      .optional(),
    // The pilot of the cache-friendly step (docs/agent-costs.md, 3.2):
    // workspace ids or owners' emails, or `*` for every workspace, whose
    // steps keep per-step notes after the history and whose browser report
    // turns keep only their few tools after the message. Only with
    // OpenRouter. Unset, every step is built as before.
    STEP_CONTEXT_WORKSPACES: workspaceListSchema.optional(),
    // The pilot of trimming old tool results in the step's prompt
    // (docs/roadmap.md, item 28): workspace ids or owners' emails, or `*`
    // for every workspace, whose steps send results, long `browser_task`
    // errands and browser reports older than the last few turns as a short
    // trace (`agent/lib/history/`). Only with the direct model. Unset, every
    // step sends the whole history as before.
    HISTORY_TRIM_WORKSPACES: workspaceListSchema.optional(),
    // The pilot of event subscriptions (docs/roadmap.md, 27): workspace ids
    // or owners' emails, or `*` for every workspace, whose Bro may set up a
    // price watch that code checks without the model (`watch-create`).
    SUBSCRIPTIONS_WORKSPACES: workspaceListSchema.optional(),
    // The pilot of the person's files for the task agent (docs/roadmap.md,
    // item 30): workspace ids, or `*` for every workspace, whose Telegram and
    // iMessage documents (tables, texts, decks) reach Bro's sandbox and,
    // when Bro names their paths to `task`, the task agent's
    // (`agent/hooks/task-files.ts`). It takes effect only inside the task
    // agent's pilot, named there by id or `*` (`taskFilesEnabled`). No
    // owners' emails: ingestion and the skill's setup decide without a
    // lookup.
    TASK_FILES_WORKSPACES: workspaceListSchema
      .refine(
        (entries) => entries.every((entry) => !entry.includes("@")),
        "TASK_FILES_WORKSPACES takes workspace ids or *, not emails"
      )
      .optional(),
    // The pilot of compacting a long conversation (docs/roadmap.md, item 28):
    // workspace ids or owners' emails, or `*` for every workspace, whose
    // turns let eve summarize the older history once a step's whole input
    // passes COMPACTION_INPUT_TOKENS, and only at the first step of a turn
    // a person's text opened (`agent/lib/compaction/`). Only with the direct
    // model. Unset, eve compacts only near the model's own window, as before.
    COMPACTION_WORKSPACES: workspaceListSchema.optional(),
    // The whole input of a step, instructions and tools included, past which
    // a pilot turn compacts. Compaction is a model call and a miss of the
    // prompt cache, so never below 100k.
    COMPACTION_INPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(100_000)
      .default(150_000),
    // The pilot of one history across channels (docs/roadmap.md, item 28):
    // workspace ids or owners' emails, or `*` for every workspace, whose
    // chats log what the person said (`conversation_log`) and whose
    // messages in one channel carry a short recap of what was said in the
    // others since (`agent/lib/conversation/`). Unset, nothing is logged.
    CROSS_CHANNEL_WORKSPACES: workspaceListSchema.optional(),
    // The pilot of the early reply: workspace ids or owners' emails, or `*`
    // for every workspace, whose person's turn may open with one short
    // heads-up («сейчас поищу») before slow work, while the turn still owes
    // the answer itself (`agent/lib/delivery/pilot.ts`). Only with the
    // direct model, which alone carries the step note that asks for it.
    // Unset, a first message that only announces work goes back to be
    // rewritten, as before.
    EARLY_REPLY_WORKSPACES: workspaceListSchema.optional(),
    // The pilot of flash mode for browser errands that only search: workspace
    // ids or owners' emails, or `*` for every workspace, whose errands on
    // their own browser (a VM or a sandbox of the pool) run browser-use's
    // flash mode when they neither sign in, submit, stage nor pay
    // (`agent/lib/browser-use/flash.ts`). Unset, every errand runs as before.
    FLASH_SEARCH_WORKSPACES: workspaceListSchema.optional(),
    // The model of the task agent (`agent/subagents/task`); unset, the
    // workspace's own model.
    TASK_AGENT_MODEL: trimmedValue.optional(),
    TELEGRAM_BOT_TOKEN: requiredValue.optional(),
    TELEGRAM_BOT_USERNAME: requiredValue
      .refine(
        (value) => /^[A-Za-z0-9_]{5,32}$/u.test(value),
        "TELEGRAM_BOT_USERNAME must be the bot handle without a leading @"
      )
      .optional(),
    // The owner's own Telegram chat with the bot, where operational alerts
    // such as a running-out model balance go when OPS_ALERT_CHAT_ID is unset.
    TELEGRAM_OWNER_CHAT_ID: z
      .string()
      .trim()
      .refine(
        (value) => /^-?\d+$/u.test(value),
        "TELEGRAM_OWNER_CHAT_ID must be a numeric Telegram chat id"
      )
      .optional(),
    TELEGRAM_WEBHOOK_SECRET_TOKEN: requiredValue.optional(),
    // A service bot for operational alerts (`agent/lib/owner-alert.ts`) and
    // the chat it writes to, the pair the host's watchdog reads too. Without
    // the bot an alert goes through Bro's own bot, into the owner's chat with
    // Bro, under a header saying it is not Bro's.
    OPS_ALERT_BOT_TOKEN: requiredValue.optional(),
    OPS_ALERT_CHAT_ID: z
      .string()
      .trim()
      .refine(
        (value) => /^-?\d+$|^@[A-Za-z0-9_]{5,32}$/u.test(value),
        "OPS_ALERT_CHAT_ID must be a numeric Telegram chat id or an @channel"
      )
      .optional(),
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
    // Cloud), converted when the cost is recorded. RouterAI bills roubles,
    // which go through it the other way and come back unchanged.
    USAGE_USD_RUB: z.coerce
      .number()
      .positive("USAGE_USD_RUB must be greater than zero")
      .default(84.41),
    VERCEL_BRANCH_URL: requiredValue.optional(),
    VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
    VERCEL_PROJECT_ID: requiredValue.optional(),
    VERCEL_PROJECT_PRODUCTION_URL: requiredValue.optional(),
    VERCEL_URL: requiredValue.optional(),
    // Where eve keeps turn state, read by `eve build`: unset on Vercel
    // (Vercel Workflow), "postgres" for the Cloud.ru VM, whose build bundles
    // @workflow/world-postgres (scripts/cloudru-app-host).
    WORKFLOW_WORLD: z.enum(["postgres"]).optional(),
    // Both YooKassa credentials together switch billing on. With either one
    // missing the deployment runs in free mode: free limits, no pay link.
    YOOKASSA_SECRET_KEY: trimmedValue.optional(),
    YOOKASSA_SHOP_ID: trimmedValue.optional(),
  },
  experimental__runtimeEnv: {},
  emptyStringAsUndefined: true,
  // A provider chosen without its key would fail every turn with a 401 that
  // names neither: the deployment fails to start instead.
  createFinalSchema: (variables) =>
    z.object(variables).superRefine((value, context) => {
      if (
        value.MODEL_PROVIDER === "routerai" &&
        value.ROUTERAI_API_KEY === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "MODEL_PROVIDER=routerai needs ROUTERAI_API_KEY",
          path: ["ROUTERAI_API_KEY"],
        });
      }
      if (
        value.BROWSER_HOST_CLOUD === "static" &&
        value.BROWSER_HOST_STATIC === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "BROWSER_HOST_CLOUD=static needs BROWSER_HOST_STATIC",
          path: ["BROWSER_HOST_STATIC"],
        });
      }
      if (
        value.MODEL_PROVIDER === "openrouter" &&
        value.OPENROUTER_API_KEY === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "MODEL_PROVIDER=openrouter needs OPENROUTER_API_KEY",
          path: ["OPENROUTER_API_KEY"],
        });
      }
      // A half-set Object Storage config would sign for Cloud.ru, or for the
      // wrong region, and every upload would fail with a 403 that names
      // neither.
      const s3 = [
        "S3_ACCESS_KEY_ID",
        "S3_ENDPOINT",
        "S3_REGION",
        "S3_SECRET_ACCESS_KEY",
      ] as const;
      if (s3.some((name) => value[name] !== undefined)) {
        for (const name of s3) {
          if (value[name] === undefined) {
            context.addIssue({
              code: "custom",
              message: `${name} is required: S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are set together`,
              path: [name],
            });
          }
        }
      }
    }),
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
