import { describe, expect, it } from "vitest";
import {
  loginHandoffReport,
  looksSignedIn,
} from "@agent/lib/login-handoff/report";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

const page = {
  allowed: true,
  passwordField: false,
  url: "https://www.ozon.ru/",
};

describe("what the page shows when the person is through", () => {
  it("reads a page with no password field on the site as signed in", () => {
    expect(looksSignedIn(page)).toBe(true);
  });

  it("does not, while a password field or a sign-in page is up, or off the site", () => {
    expect(looksSignedIn({ ...page, passwordField: true })).toBe(false);
    expect(looksSignedIn({ ...page, url: "https://www.ozon.ru/login" })).toBe(
      false
    );
    expect(looksSignedIn({ ...page, url: "https://id.vk.com/auth?x=1" })).toBe(
      false
    );
    expect(looksSignedIn({ ...page, allowed: false })).toBe(false);
  });

  it("does not guess when the worker could not tell", () => {
    expect(looksSignedIn({ ...page, passwordField: null })).toBeNull();
  });
});

function reportOf(ending: Parameters<typeof loginHandoffReport>[1]) {
  return loginHandoffReport("ozon.ru", ending);
}

describe("the report of a sign-in", () => {
  it("is a note of Bro's own that names the site and asks for nothing else", () => {
    const report = loginHandoffReport("ozon.ru", {
      kind: "done",
      signedIn: true,
    });
    expect(report.startsWith(backgroundTurnMarker)).toBe(true);
    expect(report).toContain("ozon.ru");
    expect(report).toContain("not the person's message or permission");
    expect(report).toContain("do not start an errand");
    expect(report).toContain("stay signed in");
  });

  it("says what each ending was", () => {
    expect(reportOf({ kind: "done", signedIn: false })).toContain(
      "still shows a sign-in form"
    );
    expect(reportOf({ kind: "done", signedIn: null })).toContain(
      "could not be checked"
    );
    expect(reportOf({ kind: "expired" })).toContain("closed before");
    expect(reportOf({ kind: "failed" })).toContain("had trouble");
  });
});
