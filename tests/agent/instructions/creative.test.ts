import type { DynamicResolveContext } from "eve/instructions";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

describe("creative instructions", () => {
  it("routes pictures to generate_image and edits through the last artifact", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");

    const content = await resolveContent("photon-imessage");

    expect(content).toContain("зови `generate_image`");
    expect(content).toContain("в `images` передай `artifact` последней версии");
    expect(content).toContain("Один вопрос на сообщение");
  });

  it("says plainly that pictures are unavailable without OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const content = await resolveContent("photon-imessage");

    expect(content).toContain("Рисовать картинки на этом сервере нельзя");
    expect(content).not.toContain("generate_image");
    expect(content).toContain("ты ведёшь игру сам");
  });

  it("leaves scheduled work without games or pictures", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");

    expect(await resolveContent("scheduled-worker")).toBeUndefined();
    expect(await resolveContent("scheduled-result")).toBeUndefined();
  });
});

async function resolveContent(authenticator: string) {
  const creative = (await import("@agent/instructions/60-creative")).default;
  const resolve = creative.events["turn.started"];
  if (!resolve) throw new Error("Creative instructions resolve per turn.");
  const selected = await resolve({}, dynamicContext(authenticator));
  return selected?.content;
}

function dynamicContext(authenticator: string) {
  return {
    channel: { kind: "channel:photon", metadata: {} },
    messages: [],
    model: null,
    session: {
      auth: {
        current: {
          attributes: {},
          authenticator,
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}
