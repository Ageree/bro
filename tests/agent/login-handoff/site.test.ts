import { describe, expect, it } from "vitest";
import {
  handoffSite,
  namedInWords,
  signInProviderHosts,
} from "@agent/lib/login-handoff/site";

describe("the site a sign-in link opens", () => {
  it("takes a domain or a link as the person wrote it and keeps no query", () => {
    for (const written of [
      "ozon.ru",
      "www.ozon.ru",
      "https://www.ozon.ru/my/orderlist?x=1#top",
      "HTTP://OZON.RU",
    ]) {
      const site = handoffSite(written);
      expect(site.kind).toBe("ok");
      if (site.kind !== "ok") throw new Error("unreachable");
      expect(site.domain).toBe("ozon.ru");
      expect(site.url.startsWith("https://")).toBe(true);
      expect(site.url).not.toContain("?");
      expect(site.allowedDomains).toContain("ozon.ru");
    }
    expect(handoffSite("www.ozon.ru/my/orderlist?x=1")).toMatchObject({
      url: "https://www.ozon.ru/my/orderlist",
    });
  });

  it("lets the person follow a site's own sign-in domain, and the providers only by exact host", () => {
    const site = handoffSite("wildberries.ru");
    if (site.kind !== "ok") throw new Error("Expected a site.");
    expect(site.allowedDomains).toEqual(["wildberries.ru", "wb.ru"]);
    // Whole provider domains would reach mail and messages in a profile signed in there.
    for (const host of signInProviderHosts) {
      expect(host.split(".").length).toBeGreaterThanOrEqual(3);
    }
    expect(signInProviderHosts).toEqual(
      expect.arrayContaining(["id.vk.com", "passport.yandex.ru"])
    );
    expect(signInProviderHosts).not.toContain("vk.com");
    expect(signInProviderHosts).not.toContain("yandex.ru");
  });

  it("refuses what is not a site by name", () => {
    for (const written of [
      "",
      "ozon",
      "192.168.0.1",
      "https://user:pass@ozon.ru",
      "https://ozon.ru:8443",
      "ftp://ozon.ru",
      "co.uk",
      "localhost",
      "https://[::1]/",
      "javascript:alert(1)",
    ]) {
      expect({ kind: handoffSite(written).kind, written }).toEqual({
        kind: "refused",
        written,
      });
    }
  });

  it("refuses Госуслуги and the sites that sign in through it", () => {
    for (const written of [
      "gosuslugi.ru",
      "https://esia.gosuslugi.ru",
      "mos.ru",
    ]) {
      expect(handoffSite(written)).toEqual({
        kind: "refused",
        reason: "gosuslugi",
      });
    }
  });

  it("knows a site is named only by the person's own words", () => {
    expect(namedInWords("ozon.ru", ["зайди на ozon.ru, пожалуйста"])).toBe(
      true
    );
    expect(namedInWords("ozon.ru", ["https://www.ozon.ru/my"])).toBe(true);
    expect(namedInWords("ozon.ru", ["зайди на озон"])).toBe(false);
    expect(namedInWords("ozon.ru", ["notozon.ru"])).toBe(false);
    expect(namedInWords("ozon.ru", ["ozon.ru.evil.test"])).toBe(false);
    expect(namedInWords("ozon.ru", [])).toBe(false);
  });
});
