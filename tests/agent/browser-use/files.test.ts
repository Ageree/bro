import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configured = vi.hoisted(() => ({ value: true }));
vi.mock("@agent/lib/browser-use/client", () => ({
  browserUseConfigured: () => configured.value,
}));

beforeEach(() => {
  configured.value = true;
});
afterEach(() => {
  vi.stubEnv("BROWSER_VM_FILES_WORKSPACES", "");
  vi.resetModules();
});

const path = "/workspace/attachments/0123456789abcdef/passport.pdf";

function message(
  data: URL | string,
  kind = "user",
  role: "assistant" | "user" = "user"
): ModelMessage {
  if (role === "assistant") {
    return { content: [{ text: String(data), type: "text" }], role };
  }
  return Object.assign(
    {
      content: [
        {
          data,
          filename: "passport.pdf",
          mediaType: "application/pdf",
          type: "file" as const,
        },
      ],
      role,
    },
    { kind }
  );
}

function reference(
  filePath = path,
  size = 11_347_345,
  mediaType = "application/pdf"
) {
  const url = new URL("eve-sandbox:");
  url.searchParams.set("path", filePath);
  url.searchParams.set("size", String(size));
  url.searchParams.set("type", mediaType);
  return url;
}

describe("original files for browser errands", () => {
  it("is off by default and enabled only for configured, listed workspaces", async () => {
    const { browserFilesEnabled } =
      await import("@agent/lib/browser-use/files");
    expect(browserFilesEnabled("personal:alice")).toBe(false);
    vi.stubEnv("BROWSER_VM_FILES_WORKSPACES", "personal:alice");
    vi.resetModules();
    const enabled = await import("@agent/lib/browser-use/files");
    expect(enabled.browserFilesEnabled("personal:alice")).toBe(true);
    expect(enabled.browserFilesEnabled("personal:bob")).toBe(false);
    expect(enabled.browserFilesEnabled(undefined)).toBe(false);
    configured.value = false;
    expect(enabled.browserFilesEnabled("personal:alice")).toBe(false);
  });

  it("lists the original 11.35 MB PDF and staged images even when the model sees them inline", async () => {
    const { personBrowserFiles } = await import("@agent/lib/browser-use/files");
    const image = reference(
      "/workspace/attachments/fedcba9876543210/photo.jpg",
      100,
      "image/jpeg"
    );
    expect(
      personBrowserFiles([
        message(reference()),
        message(image),
        message(reference()),
      ])
    ).toEqual([
      {
        mediaType: "application/pdf",
        name: "passport.pdf",
        path,
        size: 11_347_345,
      },
      {
        mediaType: "image/jpeg",
        name: "photo.jpg",
        path: "/workspace/attachments/fedcba9876543210/photo.jpg",
        size: 100,
      },
    ]);
  });

  it("does not accept paths from reports, memory, assistant text, remote URLs or traversal", async () => {
    const { personBrowserFiles } = await import("@agent/lib/browser-use/files");
    expect(
      personBrowserFiles([
        message(reference(), "subagent.report"),
        message(reference(), "context.browser-run"),
        message(reference(), "memory.load"),
        message(reference(), "user", "assistant"),
        message("https://example.com/passport.pdf"),
        message(reference("/workspace/attachments/0123456789abcdef/../secret")),
        message(reference("/workspace/other.txt")),
        message(reference(path, 20 * 1024 * 1024 + 1)),
        message(reference(path, 0)),
      ])
    ).toEqual([]);
  });
});
