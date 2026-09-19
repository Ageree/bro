import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GoogleWorkspaceAction } from "@app/(authenticated)/workspace/_components/google-workspace-action";

vi.mock("@web/trpc/client", () => ({
  api: {
    googleWorkspace: {
      update: {
        useMutation: () => ({
          isPending: false,
          mutate: vi.fn<(action: "connect" | "disconnect") => void>(),
        }),
      },
    },
  },
}));

describe("Google Workspace action", () => {
  it("offers OAuth to a person without a grant", () => {
    const html = renderToStaticMarkup(
      createElement(GoogleWorkspaceAction, { state: "disconnected" })
    );

    expect(html).toContain("<button");
    expect(html).toContain("Подключить");
  });

  it("does not start OAuth while the connection read is failing", () => {
    const html = renderToStaticMarkup(
      createElement(GoogleWorkspaceAction, { state: "error" })
    );

    expect(html).toContain("Google не отвечает");
    expect(html).not.toContain("<button");
  });
});
