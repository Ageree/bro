import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocalPhoneAuthForm } from "@app/sign-in/_components/local-form";
import {
  PhoneOtpAuthForm,
  phoneOtpErrorMessage,
} from "@app/sign-in/_components/otp-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn<() => void>(),
    replace: vi.fn<(href: string) => void>(),
  }),
}));

const renderForm = (form: ReactElement) =>
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, form)
  );

describe("phone OTP errors", () => {
  it("shows actionable iMessage errors", () => {
    expect(
      phoneOtpErrorMessage({
        code: "IMESSAGE_RECIPIENT_UNREACHABLE",
        message: "This number is not reachable on iMessage.",
      })
    ).toBe("This number is not reachable on iMessage.");
  });

  it("does not expose unrelated server errors", () => {
    expect(
      phoneOtpErrorMessage({
        code: "INTERNAL_SERVER_ERROR",
        message: "database connection string",
      })
    ).toBe("Не вышло отправить код. Попробуй ещё раз.");
  });

  it("asks for the phone and offers to open Messages", () => {
    const html = renderForm(
      createElement(PhoneOtpAuthForm, {
        callbackUrl: "/",
        imessagePhoneNumber: "+12025550123",
      })
    );

    expect(html).toContain(">Телефон<");
    expect(html).toContain("Получить код");
    expect(html).toContain('href="sms:+12025550123"');
    expect(html).toContain("Написать Bro");
  });

  it("says where the code comes from without a configured number", () => {
    const html = renderForm(
      createElement(PhoneOtpAuthForm, {
        callbackUrl: "/",
        imessagePhoneNumber: undefined,
      })
    );

    expect(html).toContain("Код придёт с iMessage-номера этого сервиса.");
    expect(html).not.toContain("sms:");
    expect(html).not.toContain("Написать Bro");
    const error = phoneOtpErrorMessage({
      code: "IMESSAGE_RECIPIENT_UNKNOWN",
      message:
        "Photon could not open an iMessage conversation with this number.",
    });
    expect(error).toContain("iMessage conversation");
    expect(error).not.toContain("button");
  });

  it("does not mention iMessage during local sign-in", () => {
    const html = renderForm(
      createElement(LocalPhoneAuthForm, { callbackUrl: "/" })
    );

    expect(html).not.toContain("iMessage-номера");
    expect(html).not.toContain("Написать Bro");
    expect(html).toContain("Войти");
  });
});
