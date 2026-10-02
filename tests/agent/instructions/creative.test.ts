import type { DynamicResolveContext } from "eve/instructions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A deployment that can keep pictures: the bucket and its key.
const fileStorage = {
  BROWSER_STATE_BUCKET: "bro-state-test",
  CLOUDRU_KEY_ID: "test-key-id",
  CLOUDRU_KEY_SECRET: "test-key-secret",
  CLOUDRU_S3_TENANT_ID: "test-tenant",
};

beforeEach(() => {
  vi.resetModules();
  for (const [name, value] of Object.entries(fileStorage)) {
    vi.stubEnv(name, value);
  }
});

afterEach(() => {
  for (const name of Object.keys(fileStorage)) vi.stubEnv(name, "");
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

  it("says plainly that pictures are unavailable without file storage", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("BROWSER_STATE_BUCKET", "");

    const content = await resolveContent("photon-imessage");

    expect(content).toContain("Рисовать картинки на этом сервере нельзя");
  });

  it("does not promise pictures to a caller without a workspace", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");

    const content = await resolveContent("photon-imessage", {});

    expect(content).toContain("Рисовать картинки на этом сервере нельзя");
  });

  it("leaves scheduled work without games or pictures", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");

    expect(await resolveContent("scheduled-worker")).toBeUndefined();
    expect(await resolveContent("scheduled-result")).toBeUndefined();
  });
});

async function resolveContent(
  authenticator: string,
  attributes: Record<string, string> = { workspaceId: "personal:workspace" }
) {
  const creative = (await import("@agent/instructions/60-creative")).default;
  const resolve = creative.events["turn.started"];
  if (!resolve) throw new Error("Creative instructions resolve per turn.");
  const selected = await resolve({}, dynamicContext(authenticator, attributes));
  return selected?.content;
}

function dynamicContext(
  authenticator: string,
  attributes: Record<string, string>
) {
  return {
    channel: { kind: "channel:photon", metadata: {} },
    messages: [],
    model: null,
    session: {
      auth: {
        current: {
          attributes,
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
