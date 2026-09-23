import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GoogleWorkspaceAction } from "@app/(authenticated)/workspace/_components/google-workspace-action";
import type { api } from "@web/trpc/client";

type UpdateInput = Parameters<
  ReturnType<typeof api.googleWorkspace.update.useMutation>["mutate"]
>[0];

vi.mock("@web/trpc/client", () => ({
  api: {
    googleWorkspace: {
      update: {
        useMutation: () => ({
          isPending: false,
          mutate: vi.fn<(input: UpdateInput) => void>(),
        }),
      },
    },
  },
}));

describe("Google Workspace action", () => {
  it("offers full and read-only OAuth to a person without a grant", () => {
    const html = renderToStaticMarkup(
      createElement(GoogleWorkspaceAction, { state: "disconnected" })
    );

    expect(html.match(/<button/gu)).toHaveLength(2);
    expect(html).toContain("Подключить");
    expect(html).toContain("Только чтение");
  });

  it("offers only disconnecting to a connected person", () => {
    const html = renderToStaticMarkup(
      createElement(GoogleWorkspaceAction, { state: "connected" })
    );

    expect(html.match(/<button/gu)).toHaveLength(1);
    expect(html).toContain("Отключить");
    expect(html).not.toContain("Только чтение");
  });

  it("does not start OAuth while the connection read is failing", () => {
    const html = renderToStaticMarkup(
      createElement(GoogleWorkspaceAction, { state: "error" })
    );

    expect(html).toContain("Google не отвечает");
    expect(html).not.toContain("<button");
  });
});
