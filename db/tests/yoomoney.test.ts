import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

// A fresh PGlite with every migration applied takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };
const origin = "https://bro.example";

/** YooMoney as the wallet API answers, by path; each request recorded. */
function wallet(answers: Record<string, () => Response>) {
  const requests: { path: string; body: string; authorization: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (input: URL, init: { body: URLSearchParams; headers: Headers }) => {
        const path = new URL(input).pathname;
        requests.push({
          path,
          body: init.body.toString(),
          authorization: new Headers(init.headers).get("Authorization") ?? "",
        });
        const answer = answers[path];
        if (!answer) throw new Error(`Unexpected request to ${path}`);
        return answer();
      }
    )
  );
  return requests;
}

const consenting = {
  "/oauth/token": () => Response.json({ access_token: "token-1" }),
  "/api/account-info": () =>
    Response.json({
      account: "4100111222333",
      balance: 1250.5,
      currency: "643",
      account_status: "identified",
      account_type: "personal",
    }),
  "/api/revoke": () => new Response(null, { status: 200 }),
};

beforeEach(() => {
  vi.stubEnv("YOOMONEY_CLIENT_ID", "client-1");
  vi.stubEnv("YOOMONEY_CLIENT_SECRET", "secret-1");
  vi.stubEnv("YOOMONEY_WORKSPACES", "*");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function service() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  const [Database, scope, yoomoney] = await Promise.all([
    import("@db"),
    import("@db/services/scope"),
    import("@db/services/yoomoney/connection"),
  ]);
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  return yoomoney;
}

/** The state YooMoney would send back: from the consent page's Redirect URI. */
function stateOf(consentUrl: string) {
  const redirect = new URL(consentUrl).searchParams.get("redirect_uri") ?? "";
  return new URL(redirect).searchParams.get("state") ?? "";
}

describe("the YooMoney wallet connection", () => {
  it("connects the wallet with the token the code of the person's own state gives", async () => {
    const yoomoney = await service();
    const consent = await yoomoney.startYoomoneyAuthorization(alice, origin);
    const page = new URL(consent);
    expect(page.origin + page.pathname).toBe(
      "https://yoomoney.ru/oauth/authorize"
    );
    expect(page.searchParams.get("scope")).toBe(
      'account-info operation-history payment-p2p.limit(1,50000) payment-shop.limit(1,50000) money-source("wallet","card")'
    );
    const state = stateOf(consent);
    const requests = wallet(consenting);

    // Bob cannot spend Alice's state, and a spent state does not come back.
    await expect(
      yoomoney.finishYoomoneyAuthorization(bob, "code-1", state)
    ).rejects.toThrow("истекла");
    expect(
      await yoomoney.finishYoomoneyAuthorization(alice, "code-1", state)
    ).toEqual({ account: "4100111222333", cards: [], onboardingId: null });
    await expect(
      yoomoney.finishYoomoneyAuthorization(alice, "code-1", state)
    ).rejects.toThrow("истекла");

    const token = new URLSearchParams(requests[0]?.body);
    expect(token.get("client_secret")).toBe("secret-1");
    expect(token.get("redirect_uri")).toBe(
      `${origin}/api/yoomoney/callback?state=${state}`
    );
    expect(requests[1]?.authorization).toBe("Bearer token-1");
    expect(await yoomoney.readYoomoneyConnection(alice)).toMatchObject({
      state: "connected",
      account: "4100111222333",
    });
    expect(await yoomoney.readYoomoneyConnection(bob)).toEqual({
      state: "disconnected",
    });
    expect(
      await yoomoney.withYoomoneyToken(alice, async (stored) => stored)
    ).toEqual({ connected: true, result: "token-1" });
  });

  it("stores nothing when YooMoney gives no token for the code", async () => {
    const yoomoney = await service();
    const state = stateOf(
      await yoomoney.startYoomoneyAuthorization(alice, origin)
    );
    wallet({ "/oauth/token": () => Response.json({ access_token: "" }) });
    await expect(
      yoomoney.finishYoomoneyAuthorization(alice, "wrong", state)
    ).rejects.toThrow("ЮMoney");
    expect(await yoomoney.readYoomoneyConnection(alice)).toEqual({
      state: "disconnected",
    });
  });

  it("forgets the wallet once YooMoney refuses its token", async () => {
    const yoomoney = await service();
    const state = stateOf(
      await yoomoney.startYoomoneyAuthorization(alice, origin)
    );
    wallet(consenting);
    await yoomoney.finishYoomoneyAuthorization(alice, "code-1", state);
    wallet({ "/api/account-info": () => new Response(null, { status: 401 }) });
    const { readYoomoneyAccount } = await import("@shared/yoomoney/api");
    await expect(
      yoomoney.withYoomoneyToken(alice, readYoomoneyAccount)
    ).rejects.toThrow("Подключи кошелёк заново");
    expect(await yoomoney.readYoomoneyConnection(alice)).toEqual({
      state: "disconnected",
    });
  });

  it("ends the token at YooMoney when the person disconnects", async () => {
    const yoomoney = await service();
    const state = stateOf(
      await yoomoney.startYoomoneyAuthorization(alice, origin)
    );
    const requests = wallet(consenting);
    await yoomoney.finishYoomoneyAuthorization(alice, "code-1", state);
    expect(await yoomoney.disconnectYoomoney(alice)).toEqual({
      disconnected: true,
      revoked: true,
    });
    expect(requests.at(-1)).toMatchObject({
      path: "/api/revoke",
      authorization: "Bearer token-1",
    });
    expect(await yoomoney.readYoomoneyConnection(alice)).toEqual({
      state: "disconnected",
    });
  });

  it("takes a consent anew while connected, ending the old token only once the new one is granted", async () => {
    const yoomoney = await service();
    wallet(consenting);
    await yoomoney.finishYoomoneyAuthorization(
      alice,
      "code-1",
      stateOf(await yoomoney.startYoomoneyAuthorization(alice, origin))
    );

    // YooMoney gives no token for the second consent: the first stays.
    const refused = stateOf(
      await yoomoney.startYoomoneyAuthorization(alice, origin)
    );
    wallet({ "/oauth/token": () => Response.json({ access_token: "" }) });
    await expect(
      yoomoney.finishYoomoneyAuthorization(alice, "code-2", refused)
    ).rejects.toThrow("ЮMoney");
    expect(
      await yoomoney.withYoomoneyToken(alice, async (stored) => stored)
    ).toEqual({ connected: true, result: "token-1" });

    const granted = stateOf(
      await yoomoney.startYoomoneyAuthorization(alice, origin)
    );
    const requests = wallet({
      ...consenting,
      "/oauth/token": () => Response.json({ access_token: "token-2" }),
    });
    expect(
      await yoomoney.finishYoomoneyAuthorization(alice, "code-3", granted)
    ).toEqual({ account: "4100111222333", cards: [], onboardingId: null });
    expect(
      await yoomoney.withYoomoneyToken(alice, async (stored) => stored)
    ).toEqual({ connected: true, result: "token-2" });
    expect(requests.at(-1)).toMatchObject({
      path: "/api/revoke",
      authorization: "Bearer token-1",
    });
  });
});

describe("connecting the wallet from a chat", () => {
  const telegramChat = {
    conversationChannel: "telegram" as const,
    conversationId: "4242::",
  };

  it("opens its page only for the person's device, and the consent started there for that device only", async () => {
    const yoomoney = await service();
    const onboarding = await import("@db/services/yoomoney/onboarding");
    const webChat = {
      conversationChannel: "eve" as const,
      conversationId: "session-1",
    };
    const first = await onboarding.startYoomoneyOnboarding(alice, webChat);
    // A second ask in the same chat gives the same page, one from another
    // chat a new one, and the earlier page stops opening.
    expect((await onboarding.startYoomoneyOnboarding(alice, webChat)).id).toBe(
      first.id
    );
    const started = await onboarding.startYoomoneyOnboarding(
      alice,
      telegramChat
    );
    const link = new URL(started.url);
    const token = link.searchParams.get("t") ?? "";
    expect(link.pathname).toBe(`/yoomoney/${started.id}`);
    // Only the latest link opens the page, and only with its own token.
    expect(
      await onboarding.readYoomoneyOnboardingByLink(
        first.id,
        new URL(first.url).searchParams.get("t") ?? ""
      )
    ).toBeUndefined();
    expect(
      await onboarding.readYoomoneyOnboardingByLink(started.id, "forged")
    ).toBeUndefined();
    const page = await onboarding.readYoomoneyOnboardingByLink(
      started.id,
      token
    );
    if (!page) throw new Error("Expected the page.");

    // Bob's session, or another Telegram user, does not take Alice's page.
    expect(
      await onboarding.claimYoomoneyOnboardingDevice(page, {
        kind: "session",
        userId: "bob",
      })
    ).toBeUndefined();
    expect(
      await onboarding.claimYoomoneyOnboardingDevice(page, {
        kind: "telegram",
        telegramUserId: "999",
      })
    ).toBeUndefined();
    const device = await onboarding.claimYoomoneyOnboardingDevice(page, {
      kind: "telegram",
      telegramUserId: "4242",
    });
    if (device === undefined) throw new Error("Expected the device.");
    const taken = await onboarding.readYoomoneyOnboardingByLink(
      started.id,
      token
    );
    if (!taken) throw new Error("Expected the page.");
    expect(onboarding.onYoomoneyOnboardingDevice(taken, device)).toBe(true);
    expect(onboarding.onYoomoneyOnboardingDevice(taken, "another")).toBe(false);

    const state = stateOf(
      await onboarding.startYoomoneyOnboardingConsent(taken, origin)
    );
    expect(
      await onboarding.yoomoneyOnboardingOfState(state, "another")
    ).toEqual({ id: started.id, scope: undefined });
    const owner = await onboarding.yoomoneyOnboardingOfState(state, device);
    expect(owner).toEqual({ id: started.id, scope: alice });
    wallet({
      ...consenting,
      "/api/account-info": () =>
        Response.json({
          account: "4100111222333",
          balance: 0,
          currency: "643",
          account_status: "named",
          account_type: "personal",
          cards_linked: [{ pan_fragment: "510000******9999", type: "VISA" }],
        }),
    });
    expect(
      await yoomoney.finishYoomoneyAuthorization(alice, "code-1", state)
    ).toEqual({
      account: "4100111222333",
      cards: ["••9999"],
      onboardingId: started.id,
    });
  });

  it("tells the chat once the page is through, or left on the card step, and only once", async () => {
    await service();
    const onboarding = await import("@db/services/yoomoney/onboarding");
    const withCard = await onboarding.startYoomoneyOnboarding(
      alice,
      telegramChat
    );
    const withoutCard = await onboarding.startYoomoneyOnboarding(bob, {
      conversationChannel: "eve",
      conversationId: "session-bob",
    });
    await onboarding.markYoomoneyOnboardingConnected(withCard.id, {
      cards: ["••9999"],
    });
    await onboarding.markYoomoneyOnboardingConnected(withoutCard.id, {
      cards: [],
    });

    const now = new Date();
    const told = await onboarding.claimYoomoneyOnboardingResumes(now);
    expect(told.map(({ id }) => id)).toEqual([withCard.id]);
    expect(await onboarding.claimYoomoneyOnboardingResumes(now)).toEqual([]);
    expect(
      await onboarding.readYoomoneyOnboardingResume(alice, withCard.id)
    ).toEqual({ id: withCard.id });
    expect(
      await onboarding.readYoomoneyOnboardingResume(bob, withCard.id)
    ).toBeUndefined();

    // A send that failed goes to the next tick.
    await onboarding.releaseYoomoneyOnboardingResume(withCard.id, now);
    expect(
      (await onboarding.claimYoomoneyOnboardingResumes(now)).map(({ id }) => id)
    ).toEqual([withCard.id]);

    // The page left on the card step is told after ten minutes; one that
    // finishes is told at once.
    const later = new Date(now.getTime() + 11 * 60_000);
    expect(
      (await onboarding.claimYoomoneyOnboardingResumes(later)).map(
        ({ id }) => id
      )
    ).toEqual([withoutCard.id]);
  });

  it("finishes the card step once a card is linked to the wallet", async () => {
    const yoomoney = await service();
    const onboarding = await import("@db/services/yoomoney/onboarding");
    const started = await onboarding.startYoomoneyOnboarding(
      alice,
      telegramChat
    );
    wallet(consenting);
    const state = stateOf(
      await yoomoney.startYoomoneyAuthorization(alice, origin)
    );
    await yoomoney.finishYoomoneyAuthorization(alice, "code-1", state);
    await onboarding.markYoomoneyOnboardingConnected(started.id, { cards: [] });
    const page = await onboarding.readYoomoneyOnboardingByLink(
      started.id,
      new URL(started.url).searchParams.get("t") ?? ""
    );
    if (!page) throw new Error("Expected the page.");

    expect(await onboarding.checkYoomoneyOnboardingCard(page)).toEqual({
      connected: true,
      cards: [],
    });
    expect(await onboarding.claimYoomoneyOnboardingResumes(new Date())).toEqual(
      []
    );
    wallet({
      "/api/account-info": () =>
        Response.json({
          account: "4100111222333",
          balance: 0,
          currency: "643",
          account_status: "named",
          account_type: "personal",
          cards_linked: [{ pan_fragment: "220000******4310" }],
        }),
    });
    expect(await onboarding.checkYoomoneyOnboardingCard(page)).toEqual({
      connected: true,
      cards: ["••4310"],
    });
    expect(
      (await onboarding.claimYoomoneyOnboardingResumes(new Date())).map(
        ({ id }) => id
      )
    ).toEqual([started.id]);
  });
});

describe("wallet payments", () => {
  it("are claimed once, by a yes not spent yet, and never while another may be going through", async () => {
    await service();
    const payments = await import("@db/services/yoomoney/payments");
    const quoted = (id: string) =>
      payments.createYoomoneyPayment(alice, {
        id,
        rootSessionId: "session-1",
        kind: "service",
        account: "4100111222333",
        title: "МегаФон (Россия)",
        requestParams: { pattern_id: "337" },
        shown: [],
        requestId: `request-${id}`,
        amountMinor: 10_000,
        test: false,
        cardId: null,
        cardLabel: null,
        cscRequired: null,
        confirmationQuestion: `Платёж ${id}. Оплачиваю?`,
        conversationChannel: null,
        conversationId: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
    const first = await quoted("6f0e3c1a-1111-4a8b-9c0d-000000000001");
    const second = await quoted("6f0e3c1a-1111-4a8b-9c0d-000000000002");
    const claim = (payment: typeof first, consentHash: string) =>
      payments.claimYoomoneyPayment(alice, {
        id: payment.id,
        rootSessionId: "session-1",
        confirmationQuestion: payment.confirmationQuestion,
        callId: "call-1",
        consentHash,
      });

    expect(
      await payments.claimYoomoneyPayment(alice, {
        id: first.id,
        rootSessionId: "session-1",
        confirmationQuestion: second.confirmationQuestion,
        callId: "call-1",
        consentHash: "yes-1",
      })
    ).toEqual({ kind: "unavailable" });
    expect((await claim(first, "yes-1")).kind).toBe("claimed");
    expect((await claim(first, "yes-2")).kind).toBe("existing");
    expect((await claim(second, "yes-2")).kind).toBe("busy");

    await payments.settleYoomoneyPayment(alice, {
      id: first.id,
      from: ["submitting"],
      state: "paid",
      paymentId: "payment-1",
    });
    // A settled payment is not settled again from where it no longer is.
    expect(
      await payments.settleYoomoneyPayment(alice, {
        id: first.id,
        from: ["submitting"],
        state: "refused",
      })
    ).toBeUndefined();
    // One yes pays one payment, however alike the next one is.
    expect((await claim(second, "yes-1")).kind).toBe("consent_spent");
    expect((await claim(second, "yes-2")).kind).toBe("claimed");
  });
});

describe("a payment from the wallet's linked card", () => {
  it("is paid once, by the press on its own page with the link's secret, through the bank", async () => {
    const yoomoney = await service();
    const state = stateOf(
      await yoomoney.startYoomoneyAuthorization(alice, origin)
    );
    wallet(consenting);
    await yoomoney.finishYoomoneyAuthorization(alice, "code-1", state);
    const payments = await import("@db/services/yoomoney/payments");
    const card = await import("@db/services/yoomoney/card");
    const id = "6f0e3c1a-1111-4a8b-9c0d-000000000003";
    await payments.createYoomoneyPayment(alice, {
      id,
      rootSessionId: "session-1",
      kind: "service",
      account: "4100111222333",
      title: "МегаФон (Россия)",
      requestParams: { pattern_id: "337" },
      shown: [],
      requestId: "request-1",
      amountMinor: 1000,
      test: false,
      cardId: "card-1",
      cardLabel: "••4310",
      cscRequired: true,
      confirmationQuestion: `Платёж ${id}.`,
      conversationChannel: null,
      conversationId: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const token = new URL(await card.yoomoneyPayLink(id)).searchParams.get("t");
    if (token === null) throw new Error("Expected the link's secret.");
    const requests = wallet({
      ...consenting,
      "/api/process-payment": () =>
        Response.json({
          status: "ext_auth_required",
          acs_uri: "https://bank.example/3ds",
          acs_params: { MD: "md-1", PaReq: "pareq-1" },
        }),
    });

    expect(await card.payYoomoneyByCard(id, `${token}x`, "123")).toEqual({
      kind: "unavailable",
    });
    expect(await card.payYoomoneyByCard(id, token, undefined)).toEqual({
      kind: "csc_needed",
    });
    expect(await card.payYoomoneyByCard(id, token, "123")).toEqual({
      kind: "bank",
      acsUri: "https://bank.example/3ds",
      acsParams: { MD: "md-1", PaReq: "pareq-1" },
    });
    // Its page can send the person to the bank again.
    expect(await payments.readYoomoneyPayment(alice, { id })).toMatchObject({
      state: "pending",
      bankUri: "https://bank.example/3ds",
    });
    const sent = new URLSearchParams(
      requests.find(({ path }) => path === "/api/process-payment")?.body
    );
    expect(sent.get("money_source")).toBe("card-1");
    expect(sent.get("csc")).toBe("123");
    const { applicationOrigin } = await import("@shared/environment/origin");
    const back = `${applicationOrigin()}/api/yoomoney/pay/${id}/return?t=${token}`;
    expect(sent.get("ext_auth_success_uri")).toBe(`${back}&r=ok`);
    expect(sent.get("ext_auth_fail_uri")).toBe(`${back}&r=fail`);
    // A second press pays nothing more.
    expect(await card.payYoomoneyByCard(id, token, "123")).toEqual({
      kind: "settled",
    });

    // Read back while the person is still at their bank (15.10): YooMoney
    // has no outcome yet, and the payment waits for them.
    wallet({
      "/api/process-payment": () =>
        Response.json({ status: "refused", error: "illegal_params" }),
      "/api/operation-history": () => Response.json({ operations: [] }),
    });
    await card.readBackYoomoneyCardPayment(id, token, undefined);
    expect(await payments.readYoomoneyPayment(alice, { id })).toMatchObject({
      state: "pending",
      bankUri: "https://bank.example/3ds",
    });

    const readBack = wallet({
      "/api/process-payment": () =>
        Response.json({ status: "success", payment_id: "payment-1" }),
    });
    await card.readBackYoomoneyCardPayment(id, token, "passed");
    expect(new URLSearchParams(readBack[0]?.body).toString()).toBe(
      "request_id=request-1"
    );
    expect(await payments.readYoomoneyPayment(alice, { id })).toMatchObject({
      state: "paid",
      paymentId: "payment-1",
      bankUri: null,
    });
  });

  it("stays pending, its bank form spent, when the bank did not pass the person and YooMoney has no outcome", async () => {
    const yoomoney = await service();
    const state = stateOf(
      await yoomoney.startYoomoneyAuthorization(alice, origin)
    );
    wallet(consenting);
    await yoomoney.finishYoomoneyAuthorization(alice, "code-1", state);
    const payments = await import("@db/services/yoomoney/payments");
    const card = await import("@db/services/yoomoney/card");
    const id = "6f0e3c1a-1111-4a8b-9c0d-000000000004";
    await payments.createYoomoneyPayment(alice, {
      id,
      rootSessionId: "session-1",
      kind: "service",
      account: "4100111222333",
      title: "МегаФон (Россия)",
      requestParams: { pattern_id: "337" },
      shown: [],
      requestId: "request-2",
      amountMinor: 1000,
      test: false,
      cardId: "card-1",
      cardLabel: "••4310",
      cscRequired: true,
      confirmationQuestion: `Платёж ${id}.`,
      conversationChannel: null,
      conversationId: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const token = new URL(await card.yoomoneyPayLink(id)).searchParams.get("t");
    if (token === null) throw new Error("Expected the link's secret.");
    wallet({
      ...consenting,
      "/api/process-payment": () =>
        Response.json({
          status: "ext_auth_required",
          acs_uri: "https://bank.example/3ds",
          acs_params: { MD: "md-2", PaReq: "pareq-2" },
        }),
    });
    await card.payYoomoneyByCard(id, token, "123");

    wallet({
      "/api/process-payment": () =>
        Response.json({ status: "refused", error: "illegal_params" }),
      "/api/operation-history": () => Response.json({ operations: [] }),
    });
    // Another try at the same bank form may still pass: the history
    // settles it, never the address the person came back by.
    await card.readBackYoomoneyCardPayment(id, token, "failed");
    expect(await payments.readYoomoneyPayment(alice, { id })).toMatchObject({
      state: "pending",
      bankUri: null,
      bankParams: null,
    });
  });
});

describe("a payment nobody asks about", () => {
  it("is read back after the person had their time at the bank, and its outcome is told once", async () => {
    const yoomoney = await service();
    const state = stateOf(
      await yoomoney.startYoomoneyAuthorization(alice, origin)
    );
    wallet(consenting);
    await yoomoney.finishYoomoneyAuthorization(alice, "code-1", state);
    const payments = await import("@db/services/yoomoney/payments");
    const card = await import("@db/services/yoomoney/card");
    const settle = await import("@db/services/yoomoney/settle");
    const id = "6f0e3c1a-1111-4a8b-9c0d-000000000005";
    await payments.createYoomoneyPayment(alice, {
      id,
      rootSessionId: "session-1",
      kind: "service",
      account: "4100111222333",
      title: "МегаФон (Россия)",
      requestParams: { pattern_id: "337" },
      shown: [],
      requestId: "request-5",
      amountMinor: 1000,
      test: false,
      cardId: "card-1",
      cardLabel: "••4310",
      cscRequired: true,
      confirmationQuestion: `Платёж ${id}.`,
      conversationChannel: "telegram",
      conversationId: "42::",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const token = new URL(await card.yoomoneyPayLink(id)).searchParams.get("t");
    if (token === null) throw new Error("Expected the link's secret.");
    wallet({
      ...consenting,
      "/api/process-payment": () =>
        Response.json({
          status: "ext_auth_required",
          acs_uri: "https://bank.example/3ds",
          acs_params: { MD: "md-5" },
        }),
    });
    await card.payYoomoneyByCard(id, token, "123");

    // The bank never sent the person back (15.10). While they may still be
    // there, nothing asks YooMoney about the payment.
    const early = wallet({});
    await settle.readBackYoomoneyPayments(new Date());
    expect(early).toEqual([]);
    expect(await payments.readYoomoneyPayment(alice, { id })).toMatchObject({
      state: "pending",
    });

    const later = new Date(Date.now() + 11 * 60_000);
    const readBack = wallet({
      ...consenting,
      "/api/process-payment": () =>
        Response.json({ status: "success", payment_id: "payment-5" }),
    });
    await settle.readBackYoomoneyPayments(later);
    expect(
      new URLSearchParams(
        readBack.find(({ path }) => path === "/api/process-payment")?.body
      ).toString()
    ).toBe("request_id=request-5");
    expect(await payments.readYoomoneyPayment(alice, { id })).toMatchObject({
      state: "paid",
      paymentId: "payment-5",
    });

    const told = await payments.claimYoomoneyOutcomeNotices(later);
    expect(told.map((payment) => [payment.id, payment.conversationId])).toEqual(
      [[id, "42::"]]
    );
    expect(await payments.claimYoomoneyOutcomeNotices(later)).toEqual([]);
    // A notice that did not land is taken again.
    await payments.releaseYoomoneyOutcomeNotice(id, later);
    expect(await payments.claimYoomoneyOutcomeNotices(later)).toHaveLength(1);
  });

  it("is not told again when Bro told it", async () => {
    await service();
    const payments = await import("@db/services/yoomoney/payments");
    const id = "6f0e3c1a-1111-4a8b-9c0d-000000000006";
    await payments.createYoomoneyPayment(alice, {
      id,
      rootSessionId: "session-1",
      kind: "service",
      account: "4100111222333",
      title: "МегаФон (Россия)",
      requestParams: { pattern_id: "337" },
      shown: [],
      requestId: "request-6",
      amountMinor: 1000,
      test: false,
      cardId: null,
      cardLabel: null,
      cscRequired: null,
      confirmationQuestion: `Платёж ${id}. Оплачиваю?`,
      conversationChannel: "eve",
      conversationId: "session-1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(
      await payments.claimYoomoneyPayment(alice, {
        id,
        rootSessionId: "session-1",
        confirmationQuestion: `Платёж ${id}. Оплачиваю?`,
        callId: "call-1",
        consentHash: "yes-6",
      })
    ).toMatchObject({ kind: "claimed" });
    expect(
      await payments.settleYoomoneyPayment(alice, {
        id,
        from: ["submitting"],
        state: "paid",
        paymentId: "payment-6",
      })
    ).toMatchObject({ state: "paid" });
    await payments.markYoomoneyOutcomeTold(alice, { id });
    expect(
      await payments.claimYoomoneyOutcomeNotices(new Date(Date.now() + 60_000))
    ).toEqual([]);
  });
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const name of names) {
    const migration = await readFile(new URL(name, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
}
