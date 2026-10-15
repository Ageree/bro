import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn<(path: string) => void>());
vi.mock("next/navigation", () => ({ redirect }));

import Page from "@app/(authenticated)/vault/page";

describe("old vault page", () => {
  beforeEach(() => {
    redirect.mockClear();
  });

  it("sends a link the agent already gave to the cabinet, with its query", async () => {
    await Page({
      params: Promise.resolve({}),
      searchParams: Promise.resolve({
        kind: "payment",
        label: ["a", "b"],
        setup: "vault",
      }),
    });

    expect(redirect).toHaveBeenCalledWith(
      "/workspace?kind=payment&label=a&label=b&setup=vault"
    );
  });

  it("sends a bare visit to the plain cabinet", async () => {
    await Page({
      params: Promise.resolve({}),
      searchParams: Promise.resolve({}),
    });

    expect(redirect).toHaveBeenCalledWith("/workspace");
  });
});
