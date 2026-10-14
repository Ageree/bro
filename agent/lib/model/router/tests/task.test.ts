import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://bro.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  MODEL_PROVIDER: "routerai",
  ROUTERAI_API_KEY: "routerai-test-key",
  ROUTERAI_BASE_URL: "https://routerai.test/api/v1",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

const scope = { userId: "user-1", workspaceId: "workspace-1" };
const fallback = "deepseek/deepseek-v4.1-flash";

/** The task agent's first message as eve wraps Bro's job. */
function jobMessages(job: string): ModelMessage[] {
  return [
    {
      content: `You are a subagent.\nCaller message:\n${job}`,
      role: "user",
    },
  ];
}

/** The decision model's answer for a job of `choice`. */
function decision(choice: string, confidence: number) {
  return Response.json({
    answers: { kind: { choice, confidence, type: "choice" } },
    model: "typesafe/jev-1.13-20260917",
    usage: { input_tokens: 400, output_tokens: 30 },
  });
}

const sentSchema = z.object({
  model: z.string(),
  questions: z.object({
    kind: z.object({ criteria: z.record(z.string(), z.string()) }),
  }),
  state: z.string(),
});

const fetchMock = vi.fn<typeof fetch>();

async function load() {
  return await import("@agent/lib/model/router/task");
}

beforeEach(() => {
  vi.resetModules();
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

describe("task agent model", () => {
  it("keeps the default model outside the pilot, without asking", async () => {
    const { taskAgentModel } = await load();

    await expect(
      taskAgentModel(scope, "s1", jobMessages("Сделай презентацию"), fallback)
    ).resolves.toBe(fallback);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a deck to Haiku, asking once per session", async () => {
    vi.stubEnv("MODEL_ROUTER_WORKSPACES", "*");
    fetchMock.mockResolvedValue(decision("design", 0.98));
    const { taskAgentModel } = await load();
    const messages = jobMessages("Сделай презентацию на 10 слайдов про кофе");

    await expect(taskAgentModel(scope, "s1", messages, fallback)).resolves.toBe(
      "anthropic/claude-haiku-5.5"
    );
    // The next step, a continuation too, keeps the session's model.
    await expect(taskAgentModel(scope, "s1", messages, fallback)).resolves.toBe(
      "anthropic/claude-haiku-5.5"
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://routerai.test/api/v1/systemone");
    const sent = sentSchema.parse(JSON.parse(z.string().parse(init?.body)));
    expect(sent.model).toBe("typesafe/jev-1.13");
    // Only Bro's job, without eve's preamble.
    expect(sent.state).toBe("Сделай презентацию на 10 слайдов про кофе");
    expect(Object.keys(sent.questions.kind.criteria)).toContain("design");
  });

  it("keeps the default model for a web research", async () => {
    vi.stubEnv("MODEL_ROUTER_WORKSPACES", "workspace-1");
    fetchMock.mockResolvedValue(decision("research", 0.95));
    const { taskAgentModel } = await load();

    await expect(
      taskAgentModel(scope, "s1", jobMessages("Сравни 20 CRM"), fallback)
    ).resolves.toBe(fallback);
  });

  it("keeps the default model when the decision is unsure", async () => {
    vi.stubEnv("MODEL_ROUTER_WORKSPACES", "*");
    fetchMock.mockResolvedValue(decision("code", 0.45));
    const { taskAgentModel } = await load();

    await expect(
      taskAgentModel(scope, "s1", jobMessages("Посмотри файл"), fallback)
    ).resolves.toBe(fallback);
  });

  it("keeps the default model when the decision fails", async () => {
    vi.stubEnv("MODEL_ROUTER_WORKSPACES", "*");
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "internal error" }, { status: 500 })
    );
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    fetchMock.mockResolvedValueOnce(decision("slides", 1));
    const { taskAgentModel } = await load();

    const job = jobMessages("Сделай слайды");
    await expect(taskAgentModel(scope, "s1", job, fallback)).resolves.toBe(
      fallback
    );
    await expect(taskAgentModel(scope, "s2", job, fallback)).resolves.toBe(
      fallback
    );
    await expect(taskAgentModel(scope, "s3", job, fallback)).resolves.toBe(
      fallback
    );
  });

  it("takes the routes of TASK_AGENT_ROUTES over its own", async () => {
    vi.stubEnv("MODEL_ROUTER_WORKSPACES", "*");
    vi.stubEnv("TASK_AGENT_ROUTES", "design=, research = qwen/qwen3.7-plus");
    fetchMock
      .mockResolvedValueOnce(decision("design", 0.9))
      .mockResolvedValueOnce(decision("research", 0.9))
      .mockResolvedValueOnce(decision("code", 0.9));
    const { taskAgentModel } = await load();

    await expect(
      taskAgentModel(scope, "s1", jobMessages("Слайды"), fallback)
    ).resolves.toBe(fallback);
    await expect(
      taskAgentModel(scope, "s2", jobMessages("Исследуй"), fallback)
    ).resolves.toBe("qwen/qwen3.7-plus");
    await expect(
      taskAgentModel(scope, "s3", jobMessages("Скрипт"), fallback)
    ).resolves.toBe("anthropic/claude-haiku-5.5");
  });
});
