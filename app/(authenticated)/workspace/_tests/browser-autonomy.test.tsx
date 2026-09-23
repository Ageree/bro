import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserAutonomy } from "@app/(authenticated)/workspace/_components/browser-autonomy";

const mutationState = vi.hoisted<{ error: Error | null }>(() => ({
  error: null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn<() => void>() }),
}));

vi.mock("@web/trpc/client", () => ({
  api: {
    settings: {
      setBrowserAutonomy: {
        useMutation: () => ({
          error: mutationState.error,
          isPending: false,
          mutate: vi.fn<(input: { broad: boolean }) => void>(),
        }),
      },
    },
  },
}));

describe("browser autonomy control", () => {
  beforeEach(() => {
    mutationState.error = null;
  });

  it("renders broad authority as enabled and remains revocable", () => {
    const html = renderToStaticMarkup(
      createElement(BrowserAutonomy, { broad: true })
    );

    expect(html).toContain("data-checked");
    expect(html).toContain(
      "Разрешить Bro самостоятельно выполнять действия на сайтах"
    );
  });

  it("does not silently enable broad authority by default", () => {
    const html = renderToStaticMarkup(
      createElement(BrowserAutonomy, { broad: false })
    );

    expect(html).toContain("data-unchecked");
    expect(html).toContain('aria-checked="false"');
  });

  it("shows a failed revocation beside the still-enabled switch", () => {
    mutationState.error = new Error("write failed");

    const html = renderToStaticMarkup(
      createElement(BrowserAutonomy, { broad: true })
    );

    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Не удалось сохранить настройку");
  });
});
