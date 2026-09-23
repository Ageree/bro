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

    expect(selected?.content).toContain("**каждое** явное ограничение");
    expect(selected?.content).toContain("каждый запрошенный факт");
    expect(selected?.content).toContain(
      "текст `description` сам по себе проверкой не считается"
    );
    expect(selected?.content).toContain(
      "Начальная и конечная даты, число гостей и размещение"
    );
    expect(selected?.content).toContain("одна надпись `EUR` не проверяет цену");
    expect(selected?.content).toContain("срок отмены, отдельную ванную");
    expect(selected?.content).toContain(
      "только факты одного конкретного предложения"
    );
    expect(selected?.content).toContain(
      "даты и число гостей должны иметь собственные обязательные проверки"
    );
    expect(selected?.content).toContain(
      "не называй всю цель независимо подтверждённой по частичному плану"
    );
    expect(selected?.content).toContain("дословно сохрани его в поручении");
    expect(selected?.content).toContain("не заменяй его сайтом из примера");

    const { browserTaskInputSchema } =
      await import("@agent/tools/browser_task");
    const description =
      browserTaskInputSchema.shape.verificationPlan.description;
    expect(description).toContain("every explicit constraint");
    expect(description).toContain("description text is not a check");
    expect(description).toContain("both date endpoints and occupancy");
    expect(description).toContain("currency-qualified numeric amount");
    expect(description).toContain("refund, deadline, bathroom");
    expect(description).toContain("same concrete offer, product, or rate");
    expect(description).toContain(
      "page-wide filters, dates, and occupancy need their own mandatory checks"
    );
    expect(description).toContain("negative safety check");
    expect(description).toContain("treat the plan as partial");
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
