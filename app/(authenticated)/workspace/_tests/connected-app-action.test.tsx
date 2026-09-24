import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConnectedAppAction } from "@app/(authenticated)/workspace/_components/connected-app-action";
import type { api } from "@web/trpc/client";

type UpdateInput = Parameters<
  ReturnType<typeof api.connectedApps.update.useMutation>["mutate"]
>[0];

vi.mock("@web/trpc/client", () => ({
  api: {
    connectedApps: {
      update: {
        useMutation: () => ({
          isPending: false,
          mutate: vi.fn<(input: UpdateInput) => void>(),
        }),
      },
    },
  },
}));

function render(state: "connected" | "disconnected" | "error" | "unavailable") {
  return renderToStaticMarkup(
    createElement(ConnectedAppAction, { app: "notion", name: "Notion", state })
  );
}

describe("connected app action", () => {
  it("offers connecting a person without an account", () => {
    const html = render("disconnected");

    expect(html.match(/<button/gu)).toHaveLength(1);
    expect(html).toContain("Подключить");
  });

  it("offers disconnecting a connected person", () => {
    const html = render("connected");

    expect(html.match(/<button/gu)).toHaveLength(1);
    expect(html).toContain("Отключить");
  });

  it("starts nothing while the connection read is failing or unset", () => {
    expect(render("error")).toContain("Notion не отвечает");
    expect(render("error")).not.toContain("<button");
    expect(render("unavailable")).toContain("Нужна настройка");
  });
});
