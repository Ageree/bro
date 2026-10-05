import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  BroLoginReveal,
  RevealedLogin,
} from "@app/(authenticated)/vault/_components/logins/reveal";
import type { api } from "@web/trpc/client";

type RevealInput = Parameters<
  ReturnType<typeof api.vault.reveal.useMutation>["mutate"]
>[0];

const mutate = vi.hoisted(() => vi.fn<(input: RevealInput) => void>());

vi.mock("@web/trpc/client", () => ({
  api: {
    vault: {
      reveal: {
        useMutation: () => ({
          isError: false,
          isPending: false,
          mutate,
          reset: vi.fn<() => void>(),
        }),
      },
    },
  },
}));

describe("Bro's own login in the vault", () => {
  it("marks the row and fetches nothing until asked", () => {
    const html = renderToStaticMarkup(
      createElement(BroLoginReveal, { id: "bro" })
    );

    expect(html).toContain("аккаунт Бро");
    expect(html).toContain("Показать данные для входа");
    expect(html).not.toContain("Пароль");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("shows the email and the password, each to copy, and hides them again", () => {
    const html = renderToStaticMarkup(
      createElement(RevealedLogin, {
        email: "quiet.fox42@agentmail.to",
        onHide: () => undefined,
        password: "Gen3rated!Pass",
      })
    );

    expect(html).toContain("quiet.fox42@agentmail.to");
    expect(html).toContain("Gen3rated!Pass");
    expect(html.match(/Скопировать: /gu)).toHaveLength(2);
    expect(html).toContain("Скрыть");
  });
});
