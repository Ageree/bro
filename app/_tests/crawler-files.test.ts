import { describe, expect, it } from "vitest";
import robots, * as robotsModule from "@app/robots";
import sitemap, * as sitemapModule from "@app/sitemap";

// `tests/setup-env.ts` gives the application the origin https://example.com.
const origin = "https://example.com";

describe("robots.txt", () => {
  it("lets a crawler into the landing and keeps it out of the private sections", () => {
    const { rules, sitemap: sitemapUrl } = robots();
    const rule = Array.isArray(rules) ? rules[0] : rules;

    expect(rule?.userAgent).toBe("*");
    expect(rule?.allow).toBe("/");
    expect(rule?.disallow).toEqual([
      "/workspace",
      "/chat",
      "/talk",
      "/api",
      "/eve",
      "/handoff",
      "/pay",
      "/yoomoney",
    ]);
    expect(sitemapUrl).toBe(`${origin}/sitemap.xml`);
  });

  it("does not shut out a page a visitor can open without signing in", () => {
    const { rules } = robots();
    const disallowed = [rules].flat().flatMap((rule) => rule.disallow ?? []);

    for (const path of ["/", "/sign-in", "/oferta", "/privacy"]) {
      expect(disallowed.some((prefix) => path.startsWith(prefix))).toBe(false);
    }
  });
});

describe("sitemap.xml", () => {
  it("lists only the landing: the offer and the policy say noindex", () => {
    expect(sitemap()).toEqual([{ url: `${origin}/` }]);
  });
});

// The release is built with a stub origin (`STUB_ENV` in host.py): a file
// prerendered at build would name it, so both are read per request.
it("builds both files per request, not at release build", () => {
  expect(robotsModule.dynamic).toBe("force-dynamic");
  expect(sitemapModule.dynamic).toBe("force-dynamic");
});
