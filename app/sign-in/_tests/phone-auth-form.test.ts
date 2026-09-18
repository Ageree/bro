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
    ).toBe("Unable to send a code. Please try again.");
  });

  it("explains how the code is delivered and links Messages", () => {
    const html = renderForm(
      createElement(PhoneOtpAuthForm, {
        callbackUrl: "/",
        imessagePhoneNumber: "+12025550123",
      })
    );

    expect(html).toContain("Your code arrives by iMessage");
    expect(html).toContain("can receive iMessage");
    expect(html).toContain('href="sms:+12025550123"');
    expect(html).toContain("Open Messages");
  });

  it("keeps the delivery notice visible without a configured number", () => {
    const html = renderForm(
      createElement(PhoneOtpAuthForm, {
        callbackUrl: "/",
        imessagePhoneNumber: undefined,
      })
    );

    expect(html).toContain("Your code arrives by iMessage");
    expect(html).toContain("iMessage number of this deployment");
    expect(html).not.toContain("sms:");
    const error = phoneOtpErrorMessage({
      code: "IMESSAGE_RECIPIENT_UNKNOWN",
      message:
        "Photon could not open an iMessage conversation with this number.",
    });
    expect(error).toContain("iMessage conversation");
    expect(error).not.toContain("button");
  });

  it("does not show the iMessage notice during local sign-in", () => {
    const html = renderForm(
      createElement(LocalPhoneAuthForm, { callbackUrl: "/" })
    );

    expect(html).not.toContain("Your code arrives by iMessage");
    expect(html).toContain("Continue");
  });
});
