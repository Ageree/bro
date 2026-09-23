import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as browserUseClient from "@agent/lib/browser-use/client";
import type * as BrowserCdp from "@agent/lib/browser-use/cdp";
import type * as BrowserRuns from "@db/services/browser-runs";
import type * as BrowserScheduled from "@agent/lib/browser-use/scheduled";
import {
  BrowserUseError,
  type BrowserUseCreateRunInput,
} from "@agent/lib/browser-use/client";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";
import { emptyUserProfile } from "@shared/user-profile/schema";
import {
  serializeAddressVaultPayload,
  serializeContactVaultPayload,
} from "@shared/vault/schema";

const runId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const followUpRunId = "33333333-3333-4333-8333-333333333333";
const freshSessionId = "44444444-4444-4444-8444-444444444444";
const liveViewUrl = "https://live.browser-use.com/session-1";
const transitionToken = "55555555-5555-4555-8555-555555555555";
const verificationPlan = {
  checks: [
    {
      description: "Confirmation is visible",
      id: "confirmation",
      mandatory: true,
      predicate: {
        caseSensitive: false,
        expected: "confirmed",
        kind: "text_contains" as const,
      },
    },
  ],
  version: 1 as const,
};
type BrowserRunRow = Awaited<ReturnType<typeof BrowserRuns.createBrowserRun>>;

const readBrowserRunForScope = vi.hoisted(() =>
  vi.fn<(scope: AccessScope, id: string) => Promise<BrowserRunRow | undefined>>(
    () => Promise.resolve(undefined)
  )
);
const createBrowserRun = vi.hoisted(() =>
  vi.fn<typeof BrowserRuns.createBrowserRun>()
);
const resolveBrowserRunForScope = vi.hoisted(() =>
  vi.fn<
    (
      scope: AccessScope,
      id: string
    ) => Promise<
      | {
          active: BrowserRunRow;
          requested: BrowserRunRow;
          root: BrowserRunRow;
        }
      | undefined
    >
  >()
);
const claimBrowserLineageTransition = vi.hoisted(() =>
  vi.fn<typeof BrowserRuns.claimBrowserLineageTransition>()
);
const markBrowserLineageCreating = vi.hoisted(() =>
  vi.fn<typeof BrowserRuns.markBrowserLineageCreating>()
);
const finishBrowserLineageTransition = vi.hoisted(() =>
  vi.fn<typeof BrowserRuns.finishBrowserLineageTransition>()
);
const failBrowserLineageTransition = vi.hoisted(() =>
  vi.fn<typeof BrowserRuns.failBrowserLineageTransition>()
);
const cancelBrowserLineage = vi.hoisted(() =>
  vi.fn<typeof BrowserRuns.cancelBrowserLineage>()
);
const prepareBrowserLineageTask = vi.hoisted(() =>
  vi.fn<typeof BrowserRuns.prepareBrowserLineageTask>()
);
const readBrowserRun = vi.hoisted(() =>
  vi.fn<typeof BrowserRuns.readBrowserRun>()
);
const recordBrowserLineageCancellationResult = vi.hoisted(() =>
  vi.fn<typeof BrowserRuns.recordBrowserLineageCancellationResult>()
);
const assertScheduledBrowserTaskAllowed = vi.hoisted(() =>
  vi.fn<typeof BrowserScheduled.assertScheduledBrowserTaskAllowed>()
);
const browserRunQuotaGate = vi.hoisted(() =>
  vi.fn<() => Promise<{ allowed: boolean; note: string | undefined }>>(() =>
    Promise.resolve({ allowed: true, note: undefined })
  )
);
const createBrowserUseRun = vi.hoisted(() =>
  vi.fn<
    (input: BrowserUseCreateRunInput) => Promise<{
      id: string;
      model: string;
      sessionId: string;
      status: string;
    }>
  >()
);
const cancelBrowserUseRun = vi.hoisted(() =>
  vi.fn<() => Promise<void>>(() => Promise.resolve())
);
const readBrowserUseRunStatus = vi.hoisted(() =>
  vi.fn<() => Promise<string>>(() => Promise.resolve("running"))
);
const findBrowserUseSessionCdpUrl = vi.hoisted(() =>
  vi.fn<typeof browserUseClient.findBrowserUseSessionCdpUrl>()
);
const typeOneTimeCodeOverCdp = vi.hoisted(() =>
  vi.fn<typeof BrowserCdp.typeOneTimeCodeOverCdp>()
);
const resolveBrowserSecretBindings = vi.hoisted(() =>
  vi.fn<() => Promise<{ aliases: string[]; bindings: { alias: string }[] }>>(
    () => Promise.resolve({ aliases: [], bindings: [] })
  )
);
const readUserProfile = vi.hoisted(() =>
  vi.fn<() => Promise<typeof emptyUserProfile>>(() =>
    Promise.resolve(emptyUserProfile)
  )
);
const readVaultItems = vi.hoisted(() =>
  vi.fn<
    () => Promise<
      {
        account: string;
        hasSecret: boolean;
        id: string;
        kind: string;
        label: string;
      }[]
    >
  >(() => Promise.resolve([]))
);
const readVaultSecret = vi.hoisted(() =>
  vi.fn<(scope: AccessScope, id: string) => Promise<string | undefined>>(() =>
    Promise.resolve(undefined)
  )
);
const readAccountPhoneNumber = vi.hoisted(() =>
  vi.fn<() => Promise<string | undefined>>(() => Promise.resolve(undefined))
);

type Unused = () => never;

vi.mock("@db/services/browser-runs", () => ({
  cancelBrowserLineage,
  claimBrowserLineageTransition,
  createBrowserRun,
  failBrowserLineageTransition,
  finishBrowserLineageTransition,
  markBrowserLineageCreating,
  prepareBrowserLineageTask,
  readBrowserRun,
  recordBrowserLineageCancellationResult,
  readBrowserProfileId: vi.fn<() => Promise<string>>(() =>
    Promise.resolve("profile-1")
  ),
  resolveBrowserRunForScope,
  saveBrowserProfileId: vi.fn<Unused>(),
  updateBrowserRunProgress: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("@db/services/user-profile", () => ({ readUserProfile }));
vi.mock("@db/services/users", () => ({ readAccountPhoneNumber }));
vi.mock("@db/services/vault", () => ({ readVaultItems, readVaultSecret }));
vi.mock("@agent/lib/billing/quota", () => ({ browserRunQuotaGate }));
vi.mock("@agent/lib/browser-use/secrets", () => ({
  resolveBrowserSecretBindings,
}));
vi.mock("@agent/lib/browser-use/scheduled", () => ({
  assertScheduledBrowserTaskAllowed,
}));
// The error class travels from the real module: the tool decides what to do
// with a 409 or a 404 by testing against it.
vi.mock("@agent/lib/browser-use/client", async (importOriginal) => ({
  ...(await importOriginal<typeof browserUseClient>()),
  browserUseConfigured: vi.fn<() => boolean>(() => true),
  cancelBrowserUseRun,
  createBrowserUseProfile: vi.fn<Unused>(),
  createBrowserUseRun,
  findBrowserUseSessionCdpUrl,
  // The live-view lookup gives up on the first failure, which keeps the start
  // path from waiting out its full poll budget here.
  listBrowserUseRunEvents: vi.fn<() => Promise<never>>(() =>
    Promise.reject(new Error("no events in this test"))
  ),
  liveViewUrlFromEvents: vi.fn<Unused>(),
  readBrowserUseRunStatus,
}));
vi.mock("@agent/lib/browser-use/cdp", () => ({ typeOneTimeCodeOverCdp }));

beforeEach(() => {
  const transitioned = {
    ...browserRunRow(),
    activeRunId: `pending:${transitionToken}`,
    lineageRevision: 1,
    lineageState: "claimed" as const,
    lineageTask: `Continue\n\n[BRO_TRANSITION:${transitionToken}]`,
    lineageToken: transitionToken,
  };
  claimBrowserLineageTransition.mockResolvedValue({
    marker: `pending:${transitionToken}`,
    root: transitioned,
    task: `Continue\n\n[BRO_TRANSITION:${transitionToken}]`,
    token: transitionToken,
  });
  markBrowserLineageCreating.mockResolvedValue({
    ...transitioned,
    lineageState: "creating",
  });
  finishBrowserLineageTransition.mockResolvedValue({
    ...transitioned,
    activeRunId: followUpRunId,
    lineageState: "active",
  });
  failBrowserLineageTransition.mockResolvedValue(browserRunRow());
  cancelBrowserLineage.mockResolvedValue({
    ...browserRunRow(new Date()),
    lineageRevision: 1,
    lineageState: "cancelled",
    status: "stopped",
  });
  prepareBrowserLineageTask.mockImplementation(async (input) => ({
    row: transitioned,
    task: `${input.task}\n\n[BRO_TRANSITION:${input.token}]`,
  }));
  assertScheduledBrowserTaskAllowed.mockResolvedValue(undefined);
  recordBrowserLineageCancellationResult.mockResolvedValue(browserRunRow());
  browserRunQuotaGate.mockResolvedValue({ allowed: true, note: undefined });
  readBrowserRunForScope.mockResolvedValue(undefined);
  readUserProfile.mockResolvedValue(emptyUserProfile);
  readVaultItems.mockResolvedValue([]);
  readVaultSecret.mockResolvedValue(undefined);
  readAccountPhoneNumber.mockResolvedValue(undefined);
  resolveBrowserSecretBindings.mockResolvedValue({
    aliases: [],
    bindings: [],
  });
  readBrowserUseRunStatus.mockResolvedValue("running");
  createBrowserUseRun.mockResolvedValue({
    id: followUpRunId,
    model: "hosted-agent",
    sessionId,
    status: "running",
  });
  resolveBrowserRunForScope.mockImplementation(async (scope, id) => {
    const value = await readBrowserRunForScope(scope, id);
    return value ? { active: value, requested: value, root: value } : undefined;
  });
});

afterEach(() => {
  vi.stubEnv("BROWSER_USE_MAX_COST_USD", "");
  vi.stubEnv("BROWSER_USE_PROXY_HOST", "");
  vi.stubEnv("BROWSER_USE_PROXY_PORT", "");
  vi.stubEnv("BROWSER_USE_PROXY_USERNAME", "");
  vi.stubEnv("BROWSER_USE_PROXY_PASSWORD", "");
  vi.clearAllMocks();
});

function browserRunRow(
  completedAt: Date | null = null,
  outcome: string | null = null,
  site: string | null = "https://taxi.yandex.ru",
  proxyCountryCode: string | null = "ru"
): BrowserRunRow {
  return {
    activeRunId: runId,
    capability: "browse" as const,
    completedAt,
    conversationChannel: "photon",
    conversationId: "imessage:chat-1",
    createdAt: new Date(),
    createdByUserId: "better-auth:alice",
    id: runId,
    lineageRevision: 0,
    lineagePreviousRunId: null,
    lineageRecoveryClaimedAt: null,
    lineageRecoveryToken: null,
    lineageState: "active" as const,
    lineageTask: null,
    lineageToken: null,
    liveViewUrl,
    outcome,
    profileId: "profile-1",
    proxyCountryCode,
    replyAnchorMessageId: null,
    rootSessionId: "session-1",
    rootRunId: runId,
    scheduledOrigin: null,
    sessionId,
    site,
    status: completedAt ? "done" : "running",
    task: "Войди в аккаунт на taxi.yandex.ru",
    updatedAt: new Date(),
    workspaceId: accessScopeForUser("better-auth:alice").workspaceId,
    deliveryClaimedAt: null,
    deliveredAt: null,
    deliveryState: "pending" as const,
    deliveryToken: null,
    parentRunId: null,
    repairClaimedAt: null,
    repairCount: 0,
    repairDeadline: null,
    repairState: "none" as const,
    repairTask: null,
    repairToken: null,
    verificationPlan: null,
    verificationReport: null,
    finalNeed: null,
    finalTaskStatus: null,
  };
}

async function startErrand(maxCostUsd: string, proxyCountryCode?: string) {
  vi.resetModules();
  vi.stubEnv("BROWSER_USE_MAX_COST_USD", maxCostUsd);
  createBrowserUseRun.mockResolvedValue({
    id: runId,
    model: "hosted-agent",
    sessionId,
    status: "running",
  });
  const { browserTask } = await import("@agent/tools/browser_task");
  return browserTask.execute(
    {
      action: "start",
      proxyCountryCode,
      site: "https://example.com",
      task: "Order the usual",
    },
    toolContext("better-auth:alice")
  );
}

/** The note a continuation hands back, whichever branch produced it. */
function continuationNote(
  result: { readonly note?: string } | AsyncIterable<unknown>
) {
  return "note" in result ? (result.note ?? "") : "";
}

async function continueErrand(input: {
  readonly allowPayment?: boolean;
  readonly completedAt?: Date;
  readonly message?: string;
  readonly outcome?: string;
  readonly proxyCountryCode?: string;
  readonly site?: string;
  readonly storedProxyCountryCode?: string | null;
}) {
  readBrowserRunForScope.mockResolvedValue(
    browserRunRow(
      input.completedAt ?? null,
      input.outcome ?? null,
      "https://taxi.yandex.ru",
      input.storedProxyCountryCode === undefined
        ? "ru"
        : input.storedProxyCountryCode
    )
  );
  const { browserTask } = await import("@agent/tools/browser_task");
  return browserTask.execute(
    {
      action: "continue",
      allowPayment: input.allowPayment,
      proxyCountryCode: input.proxyCountryCode,
      runId,
      site: input.site,
      task: input.message ?? "Код из смс 992130",
    },
    toolContext("better-auth:alice")
  );
}

describe("browser_task cost ceiling", () => {
  it("creates every run with the deployment's ceiling", async () => {
    await startErrand("");

    expect(createBrowserUseRun).toHaveBeenCalledOnce();
    expect(createBrowserUseRun.mock.calls[0]?.[0].maxCostUsd).toBe(1);
  });

  it("honours an overridden ceiling", async () => {
    await startErrand("2.5");

    expect(createBrowserUseRun).toHaveBeenCalledOnce();
    expect(createBrowserUseRun.mock.calls[0]?.[0].maxCostUsd).toBe(2.5);
  });
});

describe("browser_task payment capability invariant", () => {
  it("persists purchase capability whenever payment secrets are requested", async () => {
    const { browserTask } = await import("@agent/tools/browser_task");
    createBrowserUseRun.mockResolvedValue({
      id: runId,
      model: "hosted-agent",
      sessionId,
      status: "running",
    });
    await browserTask.execute(
      {
        action: "start",
        allowPayment: true,
        site: "https://example.com",
        task: "Attach the saved card without buying",
      },
      toolContext("better-auth:alice")
    );
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({ capability: "purchase" })
    );
  });

  it("rejects an explicit non-purchase capability with allowPayment", async () => {
    const { browserTaskInputSchema } =
      await import("@agent/tools/browser_task");
    const parsed = browserTaskInputSchema.safeParse({
      action: "start",
      allowPayment: true,
      capability: "browse",
      task: "Attach card",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("browser_task monthly quota", () => {
  it("records the site the errand was pointed at", async () => {
    await startErrand("");

    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({ site: "https://example.com" })
    );
  });

  it("refuses a run past the monthly ceiling before provisioning anything", async () => {
    browserRunQuotaGate.mockResolvedValue({
      allowed: false,
      note: "Лимит браузерных поручений на этот месяц исчерпан.",
    });

    const result = await startErrand("");

    expect(result).toEqual({
      note: "Лимит браузерных поручений на этот месяц исчерпан.",
      status: "quota_exhausted",
    });
    expect(createBrowserUseRun).not.toHaveBeenCalled();
  });

  it("does not charge a continuation as a new errand", async () => {
    await continueErrand({ completedAt: new Date() });

    expect(browserRunQuotaGate).not.toHaveBeenCalled();
  });
});

describe("browser_task scheduled ownership", () => {
  it("reserves scheduled completion before provisioning and persists its origin", async () => {
    const context = toolContext("better-auth:alice");
    context.session.auth.current.authenticator = "scheduled-worker";
    Object.assign(context.session.auth.current.attributes, {
      scheduledRunId: "11111111-1111-4111-8111-111111111111",
      scheduledRunLeaseToken: "22222222-2222-4222-8222-222222222222",
    });
    const { browserTask } = await import("@agent/tools/browser_task");
    createBrowserUseRun.mockResolvedValue({
      id: runId,
      model: "hosted-agent",
      sessionId,
      status: "running",
    });
    await browserTask.execute(
      { action: "start", site: "https://example.com", task: "Check status" },
      context
    );
    expect(assertScheduledBrowserTaskAllowed).toHaveBeenCalledBefore(
      createBrowserUseRun
    );
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({
        scheduledOrigin: {
          leaseToken: "22222222-2222-4222-8222-222222222222",
          runId: "11111111-1111-4111-8111-111111111111",
        },
      })
    );
  });

  it("keeps the parent Eve conversation while the browser runs in its worker session", async () => {
    const context = toolContext("better-auth:alice");
    context.session.id = "scheduled-worker-session";
    context.session.auth.current.authenticator = "scheduled-worker";
    context.session.auth.current.attributes.conversationChannel = "eve";
    context.session.auth.current.attributes.conversationId =
      "parent-eve-session";
    Object.assign(context.session.auth.current.attributes, {
      scheduledRunId: "11111111-1111-4111-8111-111111111111",
      scheduledRunLeaseToken: "22222222-2222-4222-8222-222222222222",
    });
    createBrowserUseRun.mockResolvedValue({
      id: runId,
      model: "hosted-agent",
      sessionId,
      status: "running",
    });
    const { browserTask } = await import("@agent/tools/browser_task");
    await browserTask.execute(
      { action: "start", site: "https://example.com", task: "Check status" },
      context
    );
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({
        conversationChannel: "eve",
        conversationId: "parent-eve-session",
        rootSessionId: "scheduled-worker-session",
        scheduledOrigin: {
          leaseToken: "22222222-2222-4222-8222-222222222222",
          runId: "11111111-1111-4111-8111-111111111111",
        },
      })
    );
  });
});

describe("browser_task verification plan", () => {
  it("persists a declared plan and gives the operator its exact checks", async () => {
    const { browserTask } = await import("@agent/tools/browser_task");
    createBrowserUseRun.mockResolvedValue({
      id: runId,
      model: "hosted-agent",
      sessionId,
      status: "running",
    });
    await browserTask.execute(
      {
        action: "start",
        capability: "browse",
        site: "https://example.com",
        task: "Confirm the account",
        verificationPlan,
      },
      toolContext("better-auth:alice")
    );
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({ verificationPlan })
    );
    expect(createBrowserUseRun.mock.calls[0]?.[0].task).toContain(
      JSON.stringify(verificationPlan)
    );
  });

  it("preserves the stored plan when a continuation omits it", async () => {
    const stored = { ...browserRunRow(new Date()), verificationPlan };
    readBrowserRunForScope.mockResolvedValue(stored);
    resolveBrowserRunForScope.mockResolvedValue({
      active: stored,
      requested: stored,
      root: stored,
    });
    const { browserTask } = await import("@agent/tools/browser_task");
    await browserTask.execute(
      { action: "continue", runId, task: "Continue" },
      toolContext("better-auth:alice")
    );
    expect(claimBrowserLineageTransition).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "browse", verificationPlan })
    );
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({ verificationPlan })
    );
  });

  it("does not let a browser-result continuation elevate capability or replace acceptance", async () => {
    const stored = { ...browserRunRow(new Date()), verificationPlan };
    readBrowserRunForScope.mockResolvedValue(stored);
    resolveBrowserRunForScope.mockResolvedValue({
      active: stored,
      requested: stored,
      root: stored,
    });
    const context = toolContext("better-auth:alice");
    context.session.auth.current.authenticator = "browser-result";
    Object.assign(context.session.auth.current.attributes, {
      browserRunId: stored.id,
    });
    const originalCheck = verificationPlan.checks[0];
    if (!originalCheck) throw new Error("Expected the verification check.");
    const replacement = {
      ...verificationPlan,
      checks: [{ ...originalCheck, id: "weaker-check" }],
    };
    const { browserTask } = await import("@agent/tools/browser_task");
    await browserTask.execute(
      {
        action: "continue",
        allowPayment: true,
        capability: "purchase",
        runId,
        task: "Operator asks for broader authority",
        verificationPlan: replacement,
      },
      context
    );
    expect(resolveBrowserSecretBindings).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      { allowPayment: false, site: "https://taxi.yandex.ru" }
    );
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({ capability: "browse", verificationPlan })
    );
  });

  it("rejects an old automatic result after the lineage moves to a new head", async () => {
    const root = browserRunRow(new Date());
    const active = { ...root, id: followUpRunId, parentRunId: root.id };
    resolveBrowserRunForScope.mockResolvedValue({
      active,
      requested: root,
      root: { ...root, activeRunId: active.id },
    });
    const context = toolContext("better-auth:alice");
    context.session.auth.current.authenticator = "browser-result";
    Object.assign(context.session.auth.current.attributes, {
      browserRunId: root.id,
    });
    const { browserTask } = await import("@agent/tools/browser_task");
    await expect(
      browserTask.execute(
        { action: "continue", runId: root.id, task: "Continue" },
        context
      )
    ).rejects.toThrow("automatic browser result is stale");
    await expect(
      browserTask.execute({ action: "cancel", runId: root.id }, context)
    ).rejects.toThrow("automatic browser result is stale");
    expect(findBrowserUseSessionCdpUrl).not.toHaveBeenCalled();
    expect(cancelBrowserLineage).not.toHaveBeenCalled();
    expect(cancelBrowserUseRun).not.toHaveBeenCalled();
    expect(createBrowserUseRun).not.toHaveBeenCalled();
  });

  it("allows an initial scheduled worker without a browser resume id", async () => {
    const context = toolContext("better-auth:alice");
    context.session.auth.current.authenticator = "scheduled-worker";
    const stored = browserRunRow(new Date());
    resolveBrowserRunForScope.mockResolvedValue({
      active: stored,
      requested: stored,
      root: stored,
    });
    const { browserTask } = await import("@agent/tools/browser_task");
    await expect(
      browserTask.execute(
        { action: "continue", runId, task: "Continue" },
        context
      )
    ).resolves.toMatchObject({ status: "running" });
  });
});

describe("browser_task continuation", () => {
  it("does not type a code or create a run before transition authorization", async () => {
    claimBrowserLineageTransition.mockResolvedValue(undefined);
    await expect(continueErrand({})).rejects.toThrow(
      "changed while the continuation was being prepared"
    );
    expect(findBrowserUseSessionCdpUrl).not.toHaveBeenCalled();
    expect(typeOneTimeCodeOverCdp).not.toHaveBeenCalled();
    expect(createBrowserUseRun).not.toHaveBeenCalled();
  });

  it("replaces a live run with a tracked same-session successor", async () => {
    const result = await continueErrand({});

    expect(cancelBrowserUseRun).toHaveBeenCalledExactlyOnceWith(runId);
    const successorInput = createBrowserUseRun.mock.calls[0]?.[0];
    expect(successorInput?.sessionId).toBe(sessionId);
    expect(successorInput?.task).toContain(
      `[BRO_TRANSITION:${transitionToken}]`
    );
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({
        id: followUpRunId,
        parentRunId: runId,
        rootRunId: runId,
      })
    );
    expect(result).toMatchObject({
      previousRunId: runId,
      runId: followUpRunId,
      status: "running",
    });
  });

  it("keeps a manual create ambiguity recoverable instead of unwinding its marker", async () => {
    readBrowserUseRunStatus.mockResolvedValue("completed");
    createBrowserUseRun.mockRejectedValue(
      new Error("connection reset after send")
    );
    await expect(continueErrand({ completedAt: new Date() })).rejects.toThrow(
      "connection reset"
    );
    expect(failBrowserLineageTransition).not.toHaveBeenCalled();
  });

  it("logically cancels before a provider cancellation failure", async () => {
    const stored = browserRunRow();
    readBrowserRunForScope.mockResolvedValue(stored);
    resolveBrowserRunForScope.mockResolvedValue({
      active: stored,
      requested: stored,
      root: stored,
    });
    cancelBrowserUseRun.mockRejectedValueOnce(
      new Error("provider unavailable")
    );
    const { browserTask } = await import("@agent/tools/browser_task");
    const result = await browserTask.execute(
      { action: "cancel", runId },
      toolContext("better-auth:alice")
    );
    expect(result).toMatchObject({ runId, status: "stopped" });
    expect("note" in result ? result.note : undefined).toContain(
      "could not be confirmed"
    );
    expect(cancelBrowserLineage).toHaveBeenCalledBefore(cancelBrowserUseRun);
    expect(recordBrowserLineageCancellationResult).toHaveBeenCalledWith({
      confirmed: false,
      lineageRevision: 1,
      rootRunId: runId,
    });
  });

  it("routes status from an old run id to the actual active head", async () => {
    const root = browserRunRow();
    const active = {
      ...browserRunRow(),
      id: followUpRunId,
      parentRunId: runId,
      rootRunId: runId,
    };
    resolveBrowserRunForScope.mockResolvedValue({
      active,
      requested: root,
      root: { ...root, activeRunId: followUpRunId },
    });
    readBrowserUseRunStatus.mockResolvedValue("waiting");
    const { browserTask } = await import("@agent/tools/browser_task");
    const result = await browserTask.execute(
      { action: "status", runId },
      toolContext("better-auth:alice")
    );
    expect(readBrowserUseRunStatus).toHaveBeenCalledWith(followUpRunId);
    expect(result).toMatchObject({ runId: followUpRunId, status: "waiting" });
  });

  it("starts a follow-up run in the same session once the run has finished", async () => {
    resolveBrowserSecretBindings.mockResolvedValue({
      aliases: ["login_username", "login_password"],
      bindings: [{ alias: "login_username" }, { alias: "login_password" }],
    });
    readBrowserUseRunStatus.mockResolvedValue("completed");

    const result = await continueErrand({});

    const created = createBrowserUseRun.mock.calls[0]?.[0];
    expect(created?.sessionId).toBe(sessionId);
    expect(created?.secretBindings).toHaveLength(2);
    expect(created?.task).toContain("Код из смс 992130");
    expect(created?.task).toContain("Войди в аккаунт на taxi.yandex.ru");
    expect(created?.task).toContain("Site: https://taxi.yandex.ru");
    expect(resolveBrowserSecretBindings).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      { allowPayment: false, site: "https://taxi.yandex.ru" }
    );
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({
        id: followUpRunId,
        sessionId,
        site: "https://taxi.yandex.ru",
        status: "running",
        task: "Войди в аккаунт на taxi.yandex.ru",
      })
    );
    expect(result).toMatchObject({
      boundSecrets: ["login_username", "login_password"],
      liveViewUrl,
      previousRunId: runId,
      runId: followUpRunId,
      status: "running",
    });
    expect(continuationNote(result)).toContain(followUpRunId);
  });

  it("treats a settled row as terminal without asking the cloud again", async () => {
    await continueErrand({ completedAt: new Date() });

    expect(readBrowserUseRunStatus).not.toHaveBeenCalled();
    expect(createBrowserUseRun).toHaveBeenCalledOnce();
  });

  it("replaces a live run when a card has to be bound to it", async () => {
    resolveBrowserSecretBindings.mockResolvedValue({
      aliases: ["card_number"],
      bindings: [{ alias: "card_number" }],
    });

    const result = await continueErrand({ allowPayment: true });

    expect(cancelBrowserUseRun).toHaveBeenCalledExactlyOnceWith(runId);
    expect(resolveBrowserSecretBindings).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      { allowPayment: true, site: "https://taxi.yandex.ru" }
    );
    expect(createBrowserUseRun.mock.calls[0]?.[0].secretBindings).toEqual([
      { alias: "card_number" },
    ]);
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({ capability: "purchase" })
    );
    expect(result).toMatchObject({ runId: followUpRunId });
  });

  it("fails closed when a completed session is unexpectedly busy", async () => {
    readBrowserUseRunStatus.mockResolvedValue("failed");
    createBrowserUseRun.mockRejectedValue(
      new BrowserUseError(409, "/runs", "The session already has an active run")
    );

    await expect(continueErrand({})).rejects.toThrow(
      "The browser session is busy"
    );

    expect(createBrowserRun).not.toHaveBeenCalled();
  });

  it("opens a fresh session on the same profile when the old one is gone", async () => {
    readBrowserUseRunStatus.mockResolvedValue("completed");
    createBrowserUseRun
      .mockRejectedValueOnce(
        new BrowserUseError(404, "/runs", "Run, session, workspace not found")
      )
      .mockResolvedValue({
        id: followUpRunId,
        model: "hosted-agent",
        sessionId: freshSessionId,
        status: "running",
      });

    const result = await continueErrand({ storedProxyCountryCode: "us" });

    expect(createBrowserUseRun).toHaveBeenCalledTimes(2);
    expect(createBrowserUseRun.mock.calls[0]?.[0].sessionId).toBe(sessionId);
    expect(createBrowserUseRun.mock.calls[0]?.[0].proxyCountryCode).toBe("us");
    expect(createBrowserUseRun.mock.calls[1]?.[0].sessionId).toBeUndefined();
    expect(createBrowserUseRun.mock.calls[1]?.[0].profileId).toBe("profile-1");
    expect(createBrowserUseRun.mock.calls[1]?.[0].proxyCountryCode).toBe("us");
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({
        liveViewUrl: null,
        proxyCountryCode: "us",
        sessionId: freshSessionId,
      })
    );
    expect(continuationNote(result)).toContain(
      "opened a fresh browser on the same profile"
    );
  });

  it("keeps the original goal across multiple follow-up rows", async () => {
    await continueErrand({
      completedAt: new Date(),
      message: "Выбери только тариф Комфорт",
      outcome:
        "RESULT: Вход выполнен\nSTATUS: partial\nNEXT: Выбрать тариф не дороже 1500 ₽",
      storedProxyCountryCode: "us",
    });

    const persisted = createBrowserRun.mock.calls[0]?.[1];
    expect(persisted).toEqual(
      expect.objectContaining({
        proxyCountryCode: "us",
        task: "Войди в аккаунт на taxi.yandex.ru",
      })
    );

    readBrowserRunForScope.mockResolvedValue({
      ...browserRunRow(
        new Date(),
        "RESULT: Тариф выбран\nSTATUS: partial",
        "https://taxi.yandex.ru",
        "us"
      ),
      id: followUpRunId,
      task: String(persisted?.task),
    });
    createBrowserUseRun.mockClear();

    const { browserTask } = await import("@agent/tools/browser_task");
    await browserTask.execute(
      {
        action: "continue",
        runId: followUpRunId,
        task: "Теперь закажи на 19:00",
      },
      toolContext("better-auth:alice")
    );

    const prompt = String(createBrowserUseRun.mock.calls[0]?.[0].task);
    expect(prompt).toContain("Войди в аккаунт на taxi.yandex.ru");
    expect(prompt).toContain("Теперь закажи на 19:00");
    expect(prompt).toContain("Previous checkpoint");
    expect(createBrowserUseRun.mock.calls[0]?.[0].proxyCountryCode).toBe("us");
  });

  it("reuses a safe checkpoint in a recovered session without echoing secrets", async () => {
    readBrowserUseRunStatus.mockResolvedValue("completed");
    createBrowserUseRun
      .mockRejectedValueOnce(
        new BrowserUseError(404, "/runs", "Run, session, workspace not found")
      )
      .mockResolvedValue({
        id: followUpRunId,
        model: "hosted-agent",
        sessionId: freshSessionId,
        status: "running",
      });

    await continueErrand({
      message: "Продолжай с оставшегося шага",
      outcome: [
        `RESULT: Бюджет 1500 ₽, год 2026. ${"Длинный итог. ".repeat(220)} код 992130 уже использован`,
        "STATUS: partial",
        "EVIDENCE: https://shop.example.com/product?sku=12345&color=blue",
        "https://alice:hunter2@shop.example.com/account?sessionId=private-token",
        "DETAILS: password=hunter2",
        "NEXT: Подтвердить безопасный обратимый шаг",
      ].join("\n"),
    });

    const prompt = String(createBrowserUseRun.mock.calls[1]?.[0].task);
    expect(prompt).toContain("NEXT: Подтвердить безопасный обратимый шаг");
    expect(prompt).toContain("Бюджет 1500 ₽, год 2026");
    expect(prompt).toContain(
      "https://shop.example.com/product?sku=12345&color=blue"
    );
    expect(prompt).not.toContain("992130");
    expect(prompt).not.toContain("hunter2");
    expect(prompt).not.toContain("private-token");
    expect(prompt).not.toContain("alice:");
  });

  it("does not bind a newly supplied site when the stored site is empty", async () => {
    readBrowserRunForScope.mockResolvedValue({
      ...browserRunRow(new Date()),
      site: null,
    });

    const { browserTask } = await import("@agent/tools/browser_task");
    await browserTask.execute(
      {
        action: "continue",
        runId,
        site: "https://mail.google.com",
        task: "Продолжай",
      },
      toolContext("better-auth:alice")
    );

    expect(resolveBrowserSecretBindings).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      { allowPayment: false, site: undefined }
    );
    const created = createBrowserUseRun.mock.calls[0]?.[0];
    expect(created?.task).not.toContain("mail.google.com");
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({ site: null })
    );
  });
});

describe("browser_task delegation contract", () => {
  it("retains constraints, handles amendments, and verifies acceptance criteria", async () => {
    const { composeBrowserContinuation, composeBrowserTask } =
      await import("@agent/tools/browser_task");
    const start = composeBrowserTask({
      aliases: [],
      errand: "Book a refundable room under $250",
      facts: undefined,
      site: "https://example.com",
    });
    const continuation = composeBrowserContinuation({
      aliases: [],
      checkpoint: [
        "RESULT: Budget 1500 ₽ in 2026; код 992130 used",
        "EVIDENCE: https://shop.example.com/product?sku=12345&color=blue",
        "NEXT: Keep the refundable constraint",
      ].join("\n"),
      errand: "Book a refundable room under $250",
      facts: undefined,
      message: "Change the cap to $220 but keep it refundable",
      site: "https://example.com",
    });

    expect(start).toContain("explicit acceptance checklist");
    expect(start).toContain(
      "ties every hard constraint to the same exact option"
    );
    expect(start).toContain("enclosing offer row or card");
    expect(start).toContain("included and excluded taxes or fees");
    expect(start).toContain("Re-read selected dates, guests, currency");
    expect(start).toContain("never invent a preference");
    expect(start).toContain("successful click is not evidence of success");
    expect(start).toContain("try a different safe strategy");
    expect(start).toContain("STATUS: exactly complete, partial, or blocked");
    expect(start).toContain("EVIDENCE:");
    expect(start).toContain("NEXT:");
    expect(continuation).toContain(
      "amends that goal only where it explicitly conflicts"
    );
    expect(continuation).toContain("preserve every other hard constraint");
    expect(continuation).toContain("do not guess which constraint to discard");
    expect(continuation).toContain("Budget 1500 ₽ in 2026");
    expect(continuation).toContain("product?sku=12345&color=blue");
    expect(continuation).toContain("NEXT: Keep the refundable constraint");
    expect(continuation).not.toContain("992130 used");
  });
});

describe("browser_task proxy", () => {
  it("uses the hosted pool when no proxy of our own is configured", async () => {
    await startErrand("");

    expect(createBrowserUseRun.mock.calls[0]?.[0].customProxy).toBeUndefined();
    expect(createBrowserUseRun.mock.calls[0]?.[0].proxyCountryCode).toBe("ru");
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({ proxyCountryCode: "ru" })
    );
  });

  it("normalizes and persists an explicit start country", async () => {
    await startErrand("", " US ");

    expect(createBrowserUseRun.mock.calls[0]?.[0].proxyCountryCode).toBe("us");
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({ proxyCountryCode: "us" })
    );
  });

  it("rejects an invalid start country before provisioning", async () => {
    await expect(startErrand("", "usa")).rejects.toThrow(
      "Use a two-letter country code"
    );

    expect(browserRunQuotaGate).not.toHaveBeenCalled();
    expect(createBrowserUseRun).not.toHaveBeenCalled();
    expect(createBrowserRun).not.toHaveBeenCalled();
  });

  it("uses the configured fallback for a legacy run without a country", async () => {
    await continueErrand({
      completedAt: new Date(),
      message: "Продолжай",
      storedProxyCountryCode: null,
    });

    expect(createBrowserUseRun.mock.calls[0]?.[0].proxyCountryCode).toBe("ru");
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({ proxyCountryCode: "ru" })
    );
  });

  it("does not let a continuation replace the stored country", async () => {
    await continueErrand({
      completedAt: new Date(),
      message: "Продолжай",
      proxyCountryCode: "de",
      storedProxyCountryCode: "us",
    });

    expect(createBrowserUseRun.mock.calls[0]?.[0].proxyCountryCode).toBe("us");
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({ proxyCountryCode: "us" })
    );
  });

  it("sends the deployment's own proxy with the run", async () => {
    vi.stubEnv("BROWSER_USE_PROXY_HOST", "proxy.example.com");
    vi.stubEnv("BROWSER_USE_PROXY_PORT", "8080");
    vi.stubEnv("BROWSER_USE_PROXY_USERNAME", "bro");
    vi.stubEnv("BROWSER_USE_PROXY_PASSWORD", "secret");

    const result = await startErrand("", "us");

    expect(createBrowserUseRun.mock.calls[0]?.[0].customProxy).toEqual({
      host: "proxy.example.com",
      password: "secret",
      port: 8080,
      username: "bro",
    });
    expect(createBrowserUseRun.mock.calls[0]?.[0].proxyCountryCode).toBe("us");
    expect(continuationNote(result)).toContain(
      "custom proxy overrides the requested country"
    );
  });
});

describe("browser_task pictures", () => {
  it("always asks a run for a screenshot of the page with the outcome", async () => {
    await startErrand("");

    const task = String(createBrowserUseRun.mock.calls[0]?.[0].task);
    expect(task).toContain(
      "save a screenshot of the page that shows the outcome"
    );
    expect(task).toContain("report/final.png");
    expect(task).toContain("Save nothing else under report/.");
    expect(task).not.toContain("pictures of what you found");
  });

  it("asks for pictures of the items when the person wants to see them", async () => {
    vi.resetModules();
    createBrowserUseRun.mockResolvedValue({
      id: runId,
      model: "hosted-agent",
      sessionId,
      status: "running",
    });
    const { browserTask } = await import("@agent/tools/browser_task");

    await browserTask.execute(
      {
        action: "start",
        collectImages: true,
        site: "https://www.ozon.ru",
        task: "Найди такой же фитнес-браслет и покажи фото",
      },
      toolContext("better-auth:alice")
    );

    const task = String(createBrowserUseRun.mock.calls[0]?.[0].task);
    expect(task).toContain("report/final.png");
    expect(task).toContain("also save up to 3 pictures of what you found");
    expect(task).toContain("report/xiaomi-band-9.jpg");
  });

  it("carries a later request for pictures into the follow-up run", async () => {
    readBrowserRunForScope.mockResolvedValue(browserRunRow(new Date()));
    const { browserTask } = await import("@agent/tools/browser_task");

    await browserTask.execute(
      {
        action: "continue",
        collectImages: true,
        runId,
        task: "скинь фотки",
      },
      toolContext("better-auth:alice")
    );

    const task = String(createBrowserUseRun.mock.calls[0]?.[0].task);
    expect(task.startsWith("скинь фотки")).toBe(true);
    expect(task).toContain("also save up to 3 pictures of what you found");
  });
});

describe("browser_task anti-bot checks", () => {
  it("tells a started errand to solve a CAPTCHA and carry on", async () => {
    await startErrand("");

    const task = String(createBrowserUseRun.mock.calls[0]?.[0].task);
    expect(task).toContain("solve it yourself, right away");
    expect(task).toContain("stay on it until the page lets you through");
    expect(task).toContain("drag the slider");
    expect(task).toContain("This is never the person's job");
    expect(task).toContain(
      "Stop with NEEDS: captcha only once the page still blocks you"
    );
  });

  it("carries the same rule into a follow-up run", async () => {
    await continueErrand({ completedAt: new Date() });

    expect(String(createBrowserUseRun.mock.calls[0]?.[0].task)).toContain(
      "solve it yourself, right away"
    );
  });

  it("opens a fresh browser when the run ended against an anti-bot check", async () => {
    await continueErrand({
      completedAt: new Date(),
      outcome: "Result: остановился на проверке\nNeeds: captcha",
    });

    expect(createBrowserUseRun).toHaveBeenCalledOnce();
    expect(createBrowserUseRun.mock.calls[0]?.[0].sessionId).toBeUndefined();
    expect(createBrowserUseRun.mock.calls[0]?.[0].profileId).toBe("profile-1");
  });

  it("stays in the same browser for every other outcome", async () => {
    await continueErrand({
      completedAt: new Date(),
      outcome: "Result: ждёт код\nNeeds: sms_code",
    });

    expect(createBrowserUseRun.mock.calls[0]?.[0].sessionId).toBe(sessionId);
  });

  it("keeps a follow-up on the errand's own site", async () => {
    await continueErrand({
      completedAt: new Date(),
      site: "https://mail.google.com",
    });

    const task = String(createBrowserUseRun.mock.calls[0]?.[0].task);
    expect(task).toContain("Site: https://taxi.yandex.ru");
    expect(task).not.toContain("mail.google.com");
  });
});

describe("browser_task result links", () => {
  it("requires actual observed option destinations on a started errand", async () => {
    await startErrand("");

    const task = String(createBrowserUseRun.mock.calls[0]?.[0].task);
    expect(task).toContain(
      'LINKS: a JSON array of {"title":"human-readable option name","url":"https://..."} objects, or []'
    );
    expect(task).toContain("write a complete useful report");
    expect(task).toContain("footer is routing metadata and never replaces");
    expect(task).toContain("actual observed destination URL");
    expect(task).toContain("Never guess or construct an ID or URL");
    expect(task).toContain(
      "never substitute a live-view URL or a generic search, results, or category URL"
    );
  });

  it("carries the same link contract into a follow-up run", async () => {
    await continueErrand({ completedAt: new Date() });

    const task = String(createBrowserUseRun.mock.calls[0]?.[0].task);
    expect(task).toContain("LINKS:");
    expect(task).toContain("actual anchor href");
  });
});

describe("browser_task known facts", () => {
  const contact = serializeContactVaultPayload({
    dateOfBirth: "1990-04-12",
    email: "ivan@example.com",
    fullName: "Иван Петров",
    kind: "contact",
    phone: "+79991234567",
    version: 1,
  });
  const address = serializeAddressVaultPayload({
    city: "Москва",
    countryCode: "RU",
    kind: "address",
    line1: "ул. Ленина, 1",
    postalCode: "101000",
    recipientName: "Иван Петров",
    region: "Москва",
    version: 1,
  });

  function storeVaultCards() {
    readVaultItems.mockResolvedValue([
      {
        account: "",
        hasSecret: true,
        id: "contact-1",
        kind: "contact",
        label: "Мои данные",
      },
      {
        account: "",
        hasSecret: true,
        id: "address-1",
        kind: "address",
        label: "Домашний адрес",
      },
    ]);
    readVaultSecret.mockImplementation((_scope, id) =>
      Promise.resolve(id === "contact-1" ? contact : address)
    );
  }

  it("types the vault's contact and address cards into the errand", async () => {
    storeVaultCards();

    await startErrand("");

    const task = String(createBrowserUseRun.mock.calls[0]?.[0].task);
    expect(task).toContain("Name (Мои данные): Иван Петров");
    expect(task).toContain("Phone (Мои данные): +79991234567");
    expect(task).toContain("Email (Мои данные): ivan@example.com");
    expect(task).toContain("Date of birth (Мои данные): 1990-04-12");
    expect(task).toContain(
      "Address (Домашний адрес): Иван Петров, ул. Ленина, 1, 101000, Москва, Москва, RU"
    );
  });

  it("falls back to the account's sign-in phone when nothing else has one", async () => {
    readAccountPhoneNumber.mockResolvedValue("+79990000001");

    await startErrand("");

    expect(String(createBrowserUseRun.mock.calls[0]?.[0].task)).toContain(
      "Phone: +79990000001"
    );
  });

  it("keeps the account phone out of the errand once one is known", async () => {
    storeVaultCards();
    readAccountPhoneNumber.mockResolvedValue("+79990000001");

    await startErrand("");

    expect(String(createBrowserUseRun.mock.calls[0]?.[0].task)).not.toContain(
      "+79990000001"
    );
  });
});

describe("browser_task scoping", () => {
  it("refuses an action against a run outside the caller's workspace", async () => {
    const { browserTask } = await import("@agent/tools/browser_task");

    await expect(
      browserTask.execute(
        { action: "status", runId },
        toolContext("better-auth:bob")
      )
    ).rejects.toThrow("That browser run is not part of this workspace.");
    expect(readBrowserRunForScope).toHaveBeenCalledExactlyOnceWith(
      accessScopeForUser("better-auth:bob"),
      runId
    );
  });

  it("requires an authenticated conversation", async () => {
    const { browserTask } = await import("@agent/tools/browser_task");
    const context = toolContext("better-auth:bob");
    const anonymous = {
      ...context,
      session: { ...context.session, auth: { current: null, initiator: null } },
    } satisfies ToolContext;

    await expect(
      browserTask.execute({ action: "status", runId }, anonymous)
    ).rejects.toThrow("An authenticated user is required");
  });
});

function toolContext(principalId: string) {
  return {
    abortSignal: AbortSignal.abort(),
    callId: "call-1",
    getSandbox: () => {
      throw new Error("The tool does not use a sandbox.");
    },
    getSkill: () => {
      throw new Error("The tool does not use a skill.");
    },
    getToken: () => {
      throw new Error("The tool does not use an inline token provider.");
    },
    requireAuth: (): never => {
      throw new Error("The tool does not require an inline token provider.");
    },
    session: {
      auth: {
        current: {
          attributes: {
            conversationChannel: "photon",
            conversationId: "imessage:chat-1",
            workspaceId: accessScopeForUser(principalId).workspaceId,
          },
          authenticator: "photon-imessage",
          issuer: "open-instinct",
          principalId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "browser_task",
  } satisfies ToolContext;
}
