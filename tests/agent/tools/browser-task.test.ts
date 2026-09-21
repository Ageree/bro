import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as browserUseClient from "@agent/lib/browser-use/client";
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

const readBrowserRunForScope = vi.hoisted(() =>
  vi.fn<
    (
      scope: AccessScope,
      id: string
    ) => Promise<ReturnType<typeof browserRunRow> | undefined>
  >(() => Promise.resolve(undefined))
);
const createBrowserRun = vi.hoisted(() =>
  vi.fn<() => Promise<void>>(() => Promise.resolve())
);
const claimBrowserRunCompletion = vi.hoisted(() =>
  vi.fn<() => Promise<void>>(() => Promise.resolve())
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
const queueBrowserUseSessionMessage = vi.hoisted(() =>
  vi.fn<() => Promise<void>>(() => Promise.resolve())
);
const readBrowserUseRunStatus = vi.hoisted(() =>
  vi.fn<() => Promise<string>>(() => Promise.resolve("running"))
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
  claimBrowserRunCompletion,
  createBrowserRun,
  readBrowserProfileId: vi.fn<() => Promise<string>>(() =>
    Promise.resolve("profile-1")
  ),
  readBrowserRunForScope,
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
// The error class travels from the real module: the tool decides what to do
// with a 409 or a 404 by testing against it.
vi.mock("@agent/lib/browser-use/client", async (importOriginal) => ({
  ...(await importOriginal<typeof browserUseClient>()),
  browserUseConfigured: vi.fn<() => boolean>(() => true),
  cancelBrowserUseRun,
  createBrowserUseProfile: vi.fn<Unused>(),
  createBrowserUseRun,
  // The live-view lookup gives up on the first failure, which keeps the start
  // path from waiting out its full poll budget here.
  listBrowserUseRunEvents: vi.fn<() => Promise<never>>(() =>
    Promise.reject(new Error("no events in this test"))
  ),
  liveViewUrlFromEvents: vi.fn<Unused>(),
  queueBrowserUseSessionMessage,
  readBrowserUseRunStatus,
}));

beforeEach(() => {
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
});

afterEach(() => {
  vi.stubEnv("BROWSER_USE_MAX_COST_USD", "");
  vi.clearAllMocks();
});

function browserRunRow(
  completedAt: Date | null = null,
  outcome: string | null = null
) {
  return {
    completedAt,
    conversationChannel: "photon",
    conversationId: "imessage:chat-1",
    createdAt: new Date(),
    createdByUserId: "better-auth:alice",
    id: runId,
    liveViewUrl,
    outcome,
    profileId: "profile-1",
    replyAnchorMessageId: null,
    rootSessionId: "session-1",
    sessionId,
    site: "https://taxi.yandex.ru",
    status: completedAt ? "done" : "running",
    task: "Войди в аккаунт на taxi.yandex.ru",
    updatedAt: new Date(),
    workspaceId: accessScopeForUser("better-auth:alice").workspaceId,
  };
}

async function startErrand(maxCostUsd: string) {
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
    { action: "start", site: "https://example.com", task: "Order the usual" },
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
  readonly outcome?: string;
  readonly site?: string;
}) {
  readBrowserRunForScope.mockResolvedValue(
    browserRunRow(input.completedAt ?? null, input.outcome ?? null)
  );
  const { browserTask } = await import("@agent/tools/browser_task");
  return browserTask.execute(
    {
      action: "continue",
      allowPayment: input.allowPayment,
      runId,
      site: input.site,
      task: "Код из смс 992130",
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

describe("browser_task continuation", () => {
  it("queues the message while the tracked run is still live", async () => {
    const result = await continueErrand({});

    expect(queueBrowserUseSessionMessage).toHaveBeenCalledExactlyOnceWith(
      sessionId,
      "Код из смс 992130"
    );
    expect(createBrowserUseRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({ runId, status: "running" });
  });

  it("starts a follow-up run in the same session once the run has finished", async () => {
    resolveBrowserSecretBindings.mockResolvedValue({
      aliases: ["login_username", "login_password"],
      bindings: [{ alias: "login_username" }, { alias: "login_password" }],
    });
    readBrowserUseRunStatus.mockResolvedValue("completed");

    const result = await continueErrand({});

    expect(queueBrowserUseSessionMessage).not.toHaveBeenCalled();
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
        task: "Код из смс 992130",
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
    expect(claimBrowserRunCompletion).toHaveBeenCalledExactlyOnceWith(runId, {
      outcome: "Заменён продолжением с привязанной картой",
      status: "stopped",
    });
    expect(resolveBrowserSecretBindings).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      { allowPayment: true, site: "https://taxi.yandex.ru" }
    );
    expect(createBrowserUseRun.mock.calls[0]?.[0].secretBindings).toEqual([
      { alias: "card_number" },
    ]);
    expect(result).toMatchObject({ runId: followUpRunId });
  });

  it("falls back to the queue when the session is already busy", async () => {
    readBrowserUseRunStatus.mockResolvedValue("failed");
    createBrowserUseRun.mockRejectedValue(
      new BrowserUseError(409, "/runs", "The session already has an active run")
    );

    const result = await continueErrand({});

    expect(queueBrowserUseSessionMessage).toHaveBeenCalledExactlyOnceWith(
      sessionId,
      "Код из смс 992130"
    );
    expect(createBrowserRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({ runId });
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

    const result = await continueErrand({});

    expect(createBrowserUseRun).toHaveBeenCalledTimes(2);
    expect(createBrowserUseRun.mock.calls[0]?.[0].sessionId).toBe(sessionId);
    expect(createBrowserUseRun.mock.calls[1]?.[0].sessionId).toBeUndefined();
    expect(createBrowserUseRun.mock.calls[1]?.[0].profileId).toBe("profile-1");
    expect(createBrowserRun).toHaveBeenCalledWith(
      accessScopeForUser("better-auth:alice"),
      expect.objectContaining({ liveViewUrl: null, sessionId: freshSessionId })
    );
    expect(continuationNote(result)).toContain(
      "opened a fresh browser on the same profile"
    );
  });
});

describe("browser_task anti-bot checks", () => {
  it("tells a started errand to solve a CAPTCHA and carry on", async () => {
    await startErrand("");

    const task = String(createBrowserUseRun.mock.calls[0]?.[0].task);
    expect(task).toContain(
      "Solve any CAPTCHA or anti-bot check yourself, right away"
    );
    expect(task).toContain("drag the slider");
    expect(task).toContain("This is never the person's job");
    expect(task).toContain(
      "Stop with NEEDS: captcha only if the check still blocks the page"
    );
  });

  it("carries the same rule into a follow-up run", async () => {
    await continueErrand({ completedAt: new Date() });

    expect(String(createBrowserUseRun.mock.calls[0]?.[0].task)).toContain(
      "Solve any CAPTCHA or anti-bot check yourself, right away"
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
