import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { api } from "@web/trpc/client";
import { ShareLocationButton } from "./location";

type ShareInput = Parameters<
  ReturnType<typeof api.location.share.useMutation>["mutateAsync"]
>[0];

const enabled = vi.hoisted<{ data: boolean | undefined }>(() => ({
  data: undefined,
}));

vi.mock("@web/trpc/client", () => ({
  api: {
    location: {
      enabled: { useQuery: () => ({ data: enabled.data }) },
      share: {
        useMutation: () => ({
          isPending: false,
          mutateAsync: vi.fn<(input: ShareInput) => Promise<void>>(),
        }),
      },
    },
  },
}));

function render() {
  return renderToStaticMarkup(
    createElement(ShareLocationButton, {
      disabled: false,
      onShared: vi.fn<(text: string) => Promise<void>>(),
    })
  );
}

describe("the share location button", () => {
  it("shows only in the geolocation pilot", () => {
    enabled.data = undefined;
    expect(render()).toBe("");
    enabled.data = false;
    expect(render()).toBe("");
    enabled.data = true;
    const markup = render();
    expect(markup.match(/<button/gu)).toHaveLength(1);
    expect(markup).toContain('aria-label="Поделиться геопозицией"');
    expect(markup).not.toContain("<output");
  });
});
