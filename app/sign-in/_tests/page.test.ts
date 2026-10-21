import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn<(href: string) => never>(),
  useRouter: () => ({
    refresh: vi.fn<() => void>(),
    replace: vi.fn<(href: string) => void>(),
  }),
}));

vi.mock("@web/auth/request-scope", () => ({
  requestSession: () => Promise.resolve(null),
}));

// The page reads Photon's project and the fallback line from the validated
// environment at import, so each render starts from a fresh module graph.
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("IMESSAGE_PROJECT_ID", "project-1");
  vi.stubEnv("IMESSAGE_PROJECT_SECRET", "secret-1");
  vi.stubEnv("IMESSAGE_PHONE_NUMBER", "+12025550123");
});

it("sends a signed-out newcomer neither to the iMessage line nor to a number that may be stale", async () => {
  const { default: SignInPage } = await import("@app/sign-in/page");
  const page = await SignInPage({
    params: Promise.resolve({}),
    searchParams: Promise.resolve({}),
  });
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, page)
  );

  // Photon's line answers «This number didn't recognize yours» to a phone
  // that sign-in has not yet put into its project, and `IMESSAGE_PHONE_NUMBER`
  // is only a fallback for the line Photon picks.
  expect(html).toContain("Код придёт с iMessage-номера этого сервиса.");
  expect(html).not.toContain("sms:");
  expect(html).not.toContain("Написать Bro");
  expect(html).not.toContain("+12025550123");
});
