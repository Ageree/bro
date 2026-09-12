import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tenants: defineTable({
    phoneE164: v.optional(v.string()),
    inkboxHandle: v.optional(v.string()),
    inkboxIdentityId: v.optional(v.string()),
    emailAddress: v.optional(v.string()),
    webhookSigningKey: v.optional(v.string()),
    displayName: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("disabled")),
    inkboxConversationId: v.optional(v.string()),
    photonUserId: v.optional(v.string()),
    photonConversationId: v.optional(v.string()),
    photonAssignedNumber: v.optional(v.string()),
    photonNudgeSentAt: v.optional(v.number()),
    browserSessionId: v.optional(v.string()),
    browserLiveUrl: v.optional(v.string()),
    browserRunId: v.optional(v.string()),
    browserTask: v.optional(v.string()),
    browserStatus: v.optional(v.string()),
    browserStartedAt: v.optional(v.number()),
    browserProfileId: v.optional(v.string()),
    browserCookieDomains: v.optional(v.array(v.string())),
    browserProfileSyncedAt: v.optional(v.number()),
    browserWorkflowId: v.optional(v.string()),
    browserWorkflowRunId: v.optional(v.string()),
    browserWakeupClaim: v.optional(v.string()),
    paidUntil: v.optional(v.number()),
    // deprecated: msgs/day and browser/month counters moved to @convex-dev/rate-limiter
    msgsDayKey: v.optional(v.string()),
    msgsDayCount: v.optional(v.number()),
    browserMonthKey: v.optional(v.string()),
    browserMonthCount: v.optional(v.number()),
    paywallSentDayKey: v.optional(v.string()),
    tz: v.optional(v.string()),
    dedicatedIMessageNumber: v.optional(v.string()),
    dedicatedIMessageNumberStatus: v.optional(v.string()),
    /** Last successful connected-app archive sync (Instinct-style memory). */
    archiveSyncedAt: v.optional(v.number()),
    telegramUserId: v.optional(v.string()),
    telegramChatId: v.optional(v.string()),
    telegramUsername: v.optional(v.string()),
    telegramBindToken: v.optional(v.string()),
    telegramBindExpiresAt: v.optional(v.number()),
    lastChannel: v.optional(
      v.union(v.literal("imessage"), v.literal("telegram")),
    ),
  })
    .index("by_phone", ["phoneE164"])
    .index("by_handle", ["inkboxHandle"])
    .index("by_conversation", ["inkboxConversationId"])
    .index("by_photon_conversation", ["photonConversationId"])
    .index("by_photon_user", ["photonUserId"])
    .index("by_email", ["emailAddress"])
    .index("by_telegram", ["telegramUserId"])
    .index("by_telegram_bind", ["telegramBindToken"]),

  jobs: defineTable({
    tenantId: v.id("tenants"),
    goal: v.string(),
    doneWhen: v.string(),
    status: v.union(
      v.literal("open"),
      v.literal("waiting"),
      v.literal("done"),
      v.literal("failed"),
    ),
    waitingFor: v.optional(
      v.union(v.literal("human"), v.literal("email"), v.literal("browser")),
    ),
    note: v.optional(v.string()),
    emailThreadId: v.optional(v.string()),
    emailMessageId: v.optional(v.string()),
    /** When the job last entered waiting. Used to nudge without a human ping. */
    waitingSince: v.optional(v.number()),
    lastNudgeAt: v.optional(v.number()),
  }).index("by_tenant", ["tenantId"]),

  memories: defineTable({
    phoneE164: v.string(),
    line: v.string(),
  }).index("by_phone", ["phoneE164"]),

  orders: defineTable({
    tenantId: v.id("tenants"),
    merchant: v.union(v.literal("wb"), v.literal("ozon"), v.literal("other")),
    merchantOrderId: v.string(),
    title: v.string(),
    priceRub: v.number(),
    status: v.union(
      v.literal("placed"),
      v.literal("cancelled"),
      v.literal("unknown"),
    ),
    createdAt: v.optional(v.number()),
    pickup: v.optional(v.string()),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_and_merchant_order", ["tenantId", "merchantOrderId"]),

  sessions: defineTable({
    tokenHash: v.string(),
    tenantId: v.id("tenants"),
    expiresAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_tenant", ["tenantId"]),

  loginChallenges: defineTable({
    handle: v.string(),
    codeHash: v.string(),
    expiresAt: v.number(),
    attempts: v.number(),
    createdAt: v.number(),
  }).index("by_handle", ["handle"]),

  payments: defineTable({
    tenantId: v.id("tenants"),
    yookassaId: v.string(),
    amountRub: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("succeeded"),
      v.literal("canceled"),
    ),
    createdAt: v.number(),
    paidUntilAfter: v.optional(v.number()),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_yookassa", ["yookassaId"]),

  /** Non-secret metadata. `handle` is the only vault reference the model ever sees. */
  vaultItems: defineTable({
    tenantId: v.id("tenants"),
    handle: v.string(),
    kind: v.union(
      v.literal("login"),
      v.literal("payment"),
      v.literal("address"),
      v.literal("contact"),
    ),
    label: v.string(),
    account: v.string(),
    origin: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_handle", ["handle"]),

  /** AES-256-GCM ciphertext, one row per vault item. Never leaves Convex in this form. */
  vaultSecrets: defineTable({
    tenantId: v.id("tenants"),
    handle: v.string(),
    ciphertext: v.string(),
    updatedAt: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_handle", ["handle"]),

  /** One row per worker assignment that already paid for its browser quota. */
  browserCharges: defineTable({
    tenantId: v.id("tenants"),
    workerSessionId: v.string(),
    chargedAt: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_worker", ["workerSessionId"]),

  /** Kernel browser sessions owned by a tenant. Ownership gate for every worker tool. */
  browserSessions: defineTable({
    tenantId: v.id("tenants"),
    sessionId: v.string(),
    workerSessionId: v.optional(v.string()),
    saveChanges: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_session", ["sessionId"]),

  wakeups: defineTable({
    tenantPhone: v.string(),
    at: v.number(),
    kind: v.union(
      v.literal("reminder"),
      v.literal("browser_poll"),
      v.literal("brief"),
      v.literal("watcher"),
      v.literal("job_check"),
    ),
    payload: v.string(),
    status: v.union(
      v.literal("scheduled"),
      v.literal("running"),
      v.literal("done"),
      v.literal("cancelled"),
      v.literal("failed"),
    ),
    recurMinutes: v.optional(v.number()),
    recurDailyHour: v.optional(v.number()),
    tz: v.optional(v.string()),
    lastSeen: v.optional(v.string()),
    attempts: v.optional(v.number()),
    gen: v.optional(v.number()),
  })
    .index("by_status_at", ["status", "at"])
    .index("by_tenant", ["tenantPhone"])
    .index("by_tenant_status", ["tenantPhone", "status"]),

  watchers: defineTable({
    tenantPhone: v.string(),
    source: v.union(v.literal("gmail"), v.literal("calendar")),
    triggerId: v.string(),
    triggerSlug: v.string(),
    about: v.string(),
    filter: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("stopped")),
    createdAt: v.number(),
    lastEventAt: v.optional(v.number()),
    events: v.optional(v.number()),
  })
    .index("by_tenant", ["tenantPhone"])
    .index("by_tenant_status", ["tenantPhone", "status"])
    .index("by_trigger", ["triggerId"]),

  /** Webhook dedupe. Composio retries on non-2xx; rows older than 24h are pruned. */
  composioEvents: defineTable({ eventId: v.string(), receivedAt: v.number() })
    .index("by_event", ["eventId"])
    .index("by_receivedAt", ["receivedAt"]),

  /** One Inkbox iMessage group. Never store this conversationId on tenants. */
  groupChats: defineTable({
    conversationId: v.string(),
    ownerPhoneE164: v.string(),
    inkboxHandle: v.string(),
    participants: v.array(v.string()),
    status: v.union(v.literal("active"), v.literal("disabled")),
    createdAt: v.number(),
    lastSenderPhone: v.optional(v.string()),
    greeted: v.optional(v.boolean()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_owner", ["ownerPhoneE164"])
    .index("by_handle", ["inkboxHandle"]),

  /** Durable per-tenant files. Bytes live in Convex `_storage`; this row is metadata. */
  files: defineTable({
    tenantId: v.id("tenants"),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    createdAt: v.number(),
    sourceChannel: v.optional(
      v.union(
        v.literal("imessage"),
        v.literal("telegram"),
        v.literal("sandbox"),
        v.literal("agent"),
      ),
    ),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_and_name", ["tenantId", "name"]),

  /** ChatGPT/Codex account metadata. Tokens live in chatgptSecrets. */
  chatgptAccounts: defineTable({
    tenantId: v.id("tenants"),
    accountId: v.string(),
    email: v.optional(v.string()),
    planType: v.optional(v.string()),
    connectedAt: v.number(),
    version: v.number(),
    accessExpiresAt: v.optional(v.number()),
    quarantinedAt: v.optional(v.number()),
    quarantineReason: v.optional(v.string()),
  }).index("by_tenant", ["tenantId"]),

  /** AES-256-GCM ciphertext for Codex OAuth, one row per tenant. */
  chatgptSecrets: defineTable({
    tenantId: v.id("tenants"),
    ciphertext: v.string(),
    version: v.number(),
    updatedAt: v.number(),
  }).index("by_tenant", ["tenantId"]),

  /** In-flight Codex device-code login. */
  chatgptLogins: defineTable({
    tenantId: v.id("tenants"),
    deviceAuthId: v.string(),
    userCode: v.string(),
    interval: v.number(),
    expiresAt: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("done"),
      v.literal("expired"),
      v.literal("failed"),
    ),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_deviceAuthId", ["deviceAuthId"]),
});
