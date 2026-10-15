import type * as Undici from "undici";
import type * as SystemOne from "@agent/lib/tool-router/system-one";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() =>
  vi.fn<
    (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>
  >()
);
const alertOwner = vi.hoisted(() =>
  vi.fn<(key: string, text: string) => Promise<boolean>>()
);

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof Undici>()),
  fetch: fetchMock,
}));
vi.mock("@agent/lib/owner-alert", () => ({ alertOwner }));

const typesafeHost = "api.typesafe.ai";

/** A provider's reply after `ms`, unless the request is aborted first. */
function replyAfter(ms: number, status: number, model: string) {
  return (_url: string, init: { readonly signal: AbortSignal }) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(
          new Response(
            JSON.stringify({
              answers: { mail: { noul: 0.91, type: "noul" } },
              model,
              usage: { input_tokens: 3600, output_tokens: 14 },
            }),
            { status }
          )
        );
      }, ms);
      init.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
}

/** TypeSafe and RouterAI each answer as given. */
function providers(
  typesafe: ReturnType<typeof replyAfter>,
  routerAi: ReturnType<typeof replyAfter>
) {
  fetchMock.mockImplementation((url, init) =>
    url.includes(typesafeHost) ? typesafe(url, init) : routerAi(url, init)
  );
}

const typesafeOk = (ms = 90) => replyAfter(ms, 200, "jev-1.14.0");
const routerAiOk = (ms = 400) =>
  replyAfter(ms, 200, "typesafe/jev-1.13-20260917");

function askedHosts() {
  return fetchMock.mock.calls.map(([url]) =>
    url.includes(typesafeHost) ? "typesafe" : "routerai"
  );
}

async function client(): Promise<typeof SystemOne> {
  vi.resetModules();
  return import("@agent/lib/tool-router/system-one");
}

/** One question round, with the clock run past its deadline. */
async function ask(router: typeof SystemOne, advance = 2000) {
  const answer = router.askRouterQuestions("Сообщение человека: тест", 1500);
  await vi.advanceTimersByTimeAsync(advance);
  return answer;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  alertOwner.mockReset();
  alertOwner.mockResolvedValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // Set in the test itself: `vi.unstubAllEnvs` would drop the suite's own.
  vi.stubEnv("TYPESAFE_API_KEY", "typesafe-test-key");
  vi.stubEnv("MODEL_PROVIDER", "routerai");
  vi.stubEnv("ROUTERAI_API_KEY", "routerai-test-key");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.stubEnv("TYPESAFE_API_KEY", "");
  vi.stubEnv("MODEL_PROVIDER", "");
  vi.stubEnv("ROUTERAI_API_KEY", "");
});

describe("the router's System One client", () => {
  it("takes TypeSafe's answer, with its model and tokens", async () => {
    providers(typesafeOk(), routerAiOk());
    const answer = await ask(await client());
    expect(answer).toMatchObject({
      inputTokens: 3600,
      model: "jev-1.14.0",
      outputTokens: 14,
      provider: "typesafe",
    });
    expect("answers" in answer && answer.answers.get("mail")).toBe(0.91);
    expect(askedHosts()).toEqual(["typesafe"]);
  });

  it("asks RouterAI too once TypeSafe is quiet past 250 ms, and takes the first", async () => {
    providers(typesafeOk(1200), routerAiOk(100));
    const router = await client();
    const answer = await ask(router);
    expect(answer).toMatchObject({
      model: "typesafe/jev-1.13-20260917",
      provider: "routerai",
    });
    expect(askedHosts()).toEqual(["typesafe", "routerai"]);
    // Slow is no failure: the next turn asks TypeSafe first again.
    fetchMock.mockClear();
    providers(typesafeOk(), routerAiOk());
    await ask(router);
    expect(askedHosts()).toEqual(["typesafe"]);
  });

  it("holds TypeSafe five minutes after a 5xx, then probes it in the background", async () => {
    providers(replyAfter(50, 503, "jev-1.14.0"), routerAiOk(100));
    const router = await client();
    expect(await ask(router)).toMatchObject({ provider: "routerai" });

    fetchMock.mockClear();
    providers(typesafeOk(), routerAiOk(100));
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(await ask(router)).toMatchObject({ provider: "routerai" });
    expect(askedHosts()).toEqual(["routerai"]);

    // Past the hold the probe goes out, but the turn takes RouterAI's
    // answer without waiting for it, however slow it is.
    fetchMock.mockClear();
    providers(typesafeOk(5000), routerAiOk(100));
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const pending = router.askRouterQuestions("Сообщение человека: тест", 1500);
    await vi.advanceTimersByTimeAsync(150);
    expect(await pending).toMatchObject({ provider: "routerai" });
    expect(askedHosts().toSorted()).toEqual(["routerai", "typesafe"]);

    // The probe answered: TypeSafe is first again.
    await vi.advanceTimersByTimeAsync(6000);
    fetchMock.mockClear();
    providers(typesafeOk(), routerAiOk());
    expect(await ask(router)).toMatchObject({ provider: "typesafe" });
  });

  it("holds TypeSafe an hour after a refused key, and tells the owner", async () => {
    providers(replyAfter(50, 401, "jev-1.14.0"), routerAiOk(100));
    const router = await client();
    expect(await ask(router)).toMatchObject({ provider: "routerai" });
    expect(alertOwner).toHaveBeenCalledOnce();
    expect(alertOwner.mock.calls[0]?.[0]).toBe("tool-router:typesafe-refused");

    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    providers(typesafeOk(), routerAiOk(100));
    await ask(router);
    expect(askedHosts()).toEqual(["routerai"]);
  });

  it("asks RouterAI at once without a TypeSafe key", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    providers(typesafeOk(), routerAiOk(100));
    const pending = (await client()).askRouterQuestions("state", 1500);
    await vi.advanceTimersByTimeAsync(120);
    expect(await pending).toMatchObject({ provider: "routerai" });
    expect(askedHosts()).toEqual(["routerai"]);
  });

  it("has no provider without a TypeSafe key and without RouterAI", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("MODEL_PROVIDER", "");
    vi.stubEnv("ROUTERAI_API_KEY", "");
    expect(await ask(await client())).toEqual({
      failure: "no-provider",
      ms: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives up at the deadline, and fails when both fail", async () => {
    providers(typesafeOk(5000), routerAiOk(5000));
    expect(await ask(await client())).toMatchObject({ failure: "timeout" });

    providers(
      replyAfter(50, 500, "jev-1.14.0"),
      replyAfter(100, 500, "typesafe/jev-1.13")
    );
    expect(await ask(await client())).toMatchObject({ failure: "error" });
  });

  it("reads an answer of another shape as a failure", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ answers: { mail: { noul: 3 } }, model: "jev-1.14.0" })
    );
    vi.stubEnv("MODEL_PROVIDER", "");
    vi.stubEnv("ROUTERAI_API_KEY", "");
    expect(await ask(await client())).toMatchObject({
      failure: "unreadable",
    });
  });
});
