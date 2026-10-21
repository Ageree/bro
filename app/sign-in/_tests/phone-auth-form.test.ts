import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocalPhoneAuthForm } from "@app/sign-in/_components/local-form";
import {
  PhoneOtpAuthForm,
  phoneOtpErrorMessage,
  writeFirstLine,
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
        message: "Этот номер не принимает iMessage.",
      })
    ).toBe("Этот номер не принимает iMessage.");
  });

  it.each([
    { code: "IMESSAGE_CODE_LIMIT_REACHED", message: "Too many.", status: 429 },
    { message: "Too many requests. Please try again later.", status: 429 },
  ])("says when to ask again after too many codes", (error) => {
    expect(phoneOtpErrorMessage(error)).toBe(
      "Слишком много кодов подряд. Попробуй через 10 минут."
    );
  });

  it("does not expose unrelated server errors", () => {
    expect(
      phoneOtpErrorMessage({
        code: "INTERNAL_SERVER_ERROR",
        message: "database connection string",
      })
    ).toBe("Не вышло отправить код. Попробуй ещё раз.");
  });

  it("says where the code comes from without naming a number or linking to the line", () => {
    const html = renderForm(
      createElement(PhoneOtpAuthForm, { callbackUrl: "/" })
    );

    expect(html).toContain("Код придёт с iMessage-номера этого сервиса.");
    // The line answers only phones already in its project, which sign-in adds.
    expect(html).not.toContain("sms:");
    expect(html).not.toContain("Написать Bro");
    const error = phoneOtpErrorMessage({
      code: "IMESSAGE_RECIPIENT_UNKNOWN",
      message: "Не вышло написать на этот номер в iMessage.",
    });
    expect(error).toContain("написать на этот номер");
    expect(error).not.toContain("button");
  });

  it("names the line to write to only when the server asks for a message first", () => {
    expect(
      writeFirstLine({ code: "IMESSAGE_WRITE_FIRST", line: "+16465792868" })
    ).toBe("+16465792868");
    expect(
      writeFirstLine({ code: "IMESSAGE_DELIVERY_FAILED", line: "+16465792868" })
    ).toBeUndefined();
    expect(
      writeFirstLine({ code: "IMESSAGE_WRITE_FIRST", line: "javascript:x" })
    ).toBeUndefined();
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
