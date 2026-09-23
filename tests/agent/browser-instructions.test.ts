import type { DynamicResolveContext } from "eve/instructions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getBrowserAutonomyPolicy } from "@db/services/browser-autonomy";
import {
  broadBrowserAutonomyPolicy,
  defaultBrowserAutonomyPolicy,
} from "@shared/browser/autonomy";
import { accessScopeForUser } from "@shared/identity/access-scope";

const autonomy = vi.hoisted(() => ({
  get: vi.fn<typeof getBrowserAutonomyPolicy>(),
}));
const userId = "better-auth:user-1";
const scope = accessScopeForUser(userId);

vi.mock("@agent/lib/browser-use/client", () => ({
  browserUseConfigured: () => true,
}));

vi.mock("@db/services/browser-autonomy", () => ({
  getBrowserAutonomyPolicy: autonomy.get,
}));

describe("browser autonomy instructions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    autonomy.get.mockResolvedValue(defaultBrowserAutonomyPolicy);
  });

  it("loads stored grants for the authenticated workspace", async () => {
    autonomy.get.mockResolvedValue(broadBrowserAutonomyPolicy);
    const selected = await resolveBrowserInstructions(context());

    expect(autonomy.get).toHaveBeenCalledExactlyOnceWith({
      userId,
      workspaceId: scope.workspaceId,
    });
    expect(selected?.content).toContain("уже дано широкое согласие");
    expect(selected?.content).toContain("покупки и платные бронирования");
    expect(selected?.content).toContain("не разрешают другую покупку");
    expect(selected?.content).not.toContain("Про саму покупку спроси заранее");
  });

  it("fails closed when policy lookup fails", async () => {
    autonomy.get.mockRejectedValue(new Error("database unavailable"));
    const selected = await resolveBrowserInstructions(context());

    expect(selected?.content).toContain("нет сохранённого согласия");
    expect(selected?.content).toContain(
      "нативная карточка инструмента сама запросит одно подтверждение"
    );
  });

  it("does not read grants for a non-user scheduled caller", async () => {
    const selected = await resolveBrowserInstructions(
      context({
        attributes: { workspaceId: "workspace-1" },
        authenticator: "scheduled-worker",
        principalId: "eve:app",
        principalType: "runtime",
      })
    );

    expect(autonomy.get).not.toHaveBeenCalled();
    expect(selected?.content).toContain("нет сохранённого согласия");
  });

  it("fails closed for a forged personal workspace", async () => {
    autonomy.get.mockResolvedValue(broadBrowserAutonomyPolicy);
    const selected = await resolveBrowserInstructions(
      context({
        attributes: { workspaceId: "personal:forged" },
        authenticator: "photon-imessage",
        principalId: userId,
        principalType: "user",
      })
    );

    expect(autonomy.get).not.toHaveBeenCalled();
    expect(selected?.content).toContain("нет сохранённого согласия");
  });

  it("requires complete predicate coverage and preserves a supplied URL", async () => {
    const selected = await resolveBrowserInstructions(context());

    expect(selected?.content).toContain("каждое явное ограничение");
    expect(selected?.content).toContain("каждый запрошенный факт");
    expect(selected?.content).toContain(
      "`description` объясняет проверку, но никогда не служит доказательством"
    );
    expect(selected?.content).toContain(
      "Даты задавай каноническим предикатом `date`"
    );
    expect(selected?.content).toContain(
      "не названный человеком год, количество, цену"
    );
    expect(selected?.content).toContain("срок отмены, ванную");
    expect(selected?.content).toContain(
      "только проверки одного конкретного предложения"
    );
    expect(selected?.content).toContain(
      'проверку его идентичности с `purpose: "identity"`'
    );
    expect(selected?.content).toContain(
      "неизвестное до открытия сайта название можно получить через `text_present`"
    );
    expect(selected?.content).toContain(
      "Само присутствие текста не доказывает бесплатность"
    );
    expect(selected?.content).toContain(
      "проверяй его отдельным предикатом `link`, а запрошенную подпись — отдельным текстовым предикатом: видимая подпись не доказывает URL"
    );
    expect(selected?.content).toContain("все запрошенные факты этого варианта");
    expect(selected?.content).toContain(
      "Фильтры и состояние всей страницы проверяй отдельно"
    );
    expect(selected?.content).toContain(
      "не превращает частичный план в независимую проверку всей цели"
    );
    expect(selected?.content).toContain("дословно сохрани его в поручении");
    expect(selected?.content).toContain("не заменяй его сайтом из примера");

    const { browserTaskInputSchema } =
      await import("@agent/tools/browser_task");
    const description =
      browserTaskInputSchema.shape.verificationPlan.description;
    expect(description).toContain("every explicit constraint");
    expect(description).toContain("option identity");
    expect(description).toContain("description text is never evidence");
    expect(description).toContain("canonical typed date predicates");
    expect(description).toContain("numberWords");
    expect(description).toContain(
      "never guess display strings, an unspecified year"
    );
    expect(description).toContain("one positive identity check");
    expect(description).toContain(
      "Every groupId must contain an identity text_exact, text_contains, or text_present predicate"
    );
    expect(description).toContain("never use presence alone to prove");
    expect(description).toContain(
      "A collection or group heading does not identify its nested concrete items"
    );
    expect(description).toContain("Keep page-wide scope checks ungrouped");
    expect(description).toContain("leave it explicitly unverified");
  });

  it("routes explicit browser requirements through browser_task", async () => {
    const selected = await resolveBrowserInstructions(context());

    expect(selected?.content).toContain(
      "прямо просит открыть или использовать браузер"
    );
    expect(selected?.content).toContain(
      "только когда в просьбе нет требования к браузеру"
    );

    const { browserTask } = await import("@agent/tools/browser_task");
    expect(browserTask.description).toContain(
      "explicitly asks to open or use a browser"
    );
    expect(browserTask.description).toContain(
      "only when the request has no browser-specific requirement"
    );
  });
});

async function resolveBrowserInstructions(
  resolveContext: DynamicResolveContext
) {
  const instructions = (await import("@agent/instructions/40-browser")).default;
  const resolve = instructions.events["turn.started"];
  expect(resolve).toBeDefined();
  return resolve?.({}, resolveContext);
}

function context(
  current: DynamicResolveContext["session"]["auth"]["current"] = {
    attributes: { workspaceId: scope.workspaceId },
    authenticator: "photon-imessage",
    principalId: userId,
    principalType: "user",
  }
) {
  return {
    channel: { kind: "channel:photon", metadata: {} },
    messages: [],
    model: null,
    session: {
      auth: { current, initiator: null },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}
