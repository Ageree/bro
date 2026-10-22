import type { DynamicResolveContext } from "eve/instructions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  afishaPurchasePilot,
  yandexPurchasePilot,
} from "@agent/lib/yandex/pilot";

const purchasePilot = vi.hoisted(() => vi.fn<typeof yandexPurchasePilot>());
const afishaPilot = vi.hoisted(() => vi.fn<typeof afishaPurchasePilot>());
vi.mock("@agent/lib/yandex/pilot", () => ({
  afishaPurchasePilot: afishaPilot,
  yandexPurchasePilot: purchasePilot,
}));

import yandexInstructions from "@agent/instructions/42-yandex";

function context(authenticator = "authjs"): DynamicResolveContext {
  return {
    channel: { kind: "channel:eve", metadata: {} },
    messages: [],
    model: null,
    session: {
      id: "session-1",
      auth: {
        initiator: null,
        current: {
          attributes: { workspaceId: "workspace:alice" },
          authenticator,
          principalId: "alice",
          principalType: "user",
        },
      },
    },
  };
}

beforeEach(() => {
  purchasePilot.mockReset().mockReturnValue(true);
  afishaPilot.mockReset().mockReturnValue(false);
});

describe("the Yandex order confirmation policy", () => {
  it("gives food one final question and direct taxi requests no extra confirmation", async () => {
    const resolve = yandexInstructions.events["turn.started"];
    const instruction = await resolve?.({}, context());
    expect(instruction?.content).toContain("ровно один финальный вопрос");
    expect(instruction?.content).toContain(
      "`book` без дополнительного подтверждения"
    );
    expect(instruction?.content).toContain("или найдены");
    expect(instruction?.content).toContain("не разрешает заказ");
    expect(instruction?.content).toContain("не отменяй автоматически");
    expect(purchasePilot).toHaveBeenCalledWith({
      userId: "alice",
      workspaceId: "workspace:alice",
    });
  });

  it("buys Afisha's tickets through its API only in the Afisha pilot", async () => {
    const resolve = yandexInstructions.events["turn.started"];
    const outside = await resolve?.({}, context());
    afishaPilot.mockReturnValue(true);
    const inside = await resolve?.({}, context());

    expect(outside?.content).not.toContain("Билеты Яндекс Афиши");
    expect(inside?.content).toContain(
      'зону без мест покупай через `yandex_purchase` с `service: "afisha"`'
    );
  });

  it("leaves a disabled workspace's instructions unchanged", async () => {
    purchasePilot.mockReturnValue(false);
    const resolve = yandexInstructions.events["turn.started"];
    expect(await resolve?.({}, context())).toBeNull();
  });

  it.each([
    "scheduled-worker",
    "scheduled-result",
    "browser-result",
    "background-task",
  ])("does not authorize purchases from %s", async (authenticator) => {
    const resolve = yandexInstructions.events["turn.started"];
    expect(await resolve?.({}, context(authenticator))).toBeNull();
  });
});
