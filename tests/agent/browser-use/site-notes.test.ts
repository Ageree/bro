import { afterEach, describe, expect, it } from "vitest";
import { composeBrowserTask } from "@agent/tools/browser_task";
import {
  clearBrowserVmSettings,
  importWithSettings,
} from "../../helpers/browser-vm";

const scope = { workspaceId: "personal:owner" };

async function lineFor(pilot: string, site: string | undefined) {
  const notes = await importWithSettings(
    { BROWSER_SITE_NOTES_WORKSPACES: pilot },
    async () => import("@agent/lib/browser-use/site-notes")
  );
  return notes.siteNoteLine(scope, site);
}

describe("a site's note in the errand's task", () => {
  afterEach(clearBrowserVmSettings);

  it("tells the run how the site writes its results' address, in the pilot only", async () => {
    const tutu = await lineFor("personal:owner", "https://www.tutu.ru/poezda/");
    expect(tutu).toMatch(
      /^About this site: trains for a date open straight at https:\/\/www\.tutu\.ru\/poezda\/<From>\/<To>\/\?date=DD\.MM\.YYYY/u
    );
    expect(await lineFor("*", "https://m.lemanapro.ru/")).toContain(
      "lemanapro.ru/search/?q="
    );
    expect(
      await lineFor("personal:other", "https://www.tutu.ru/")
    ).toBeUndefined();
    expect(await lineFor("", "https://www.tutu.ru/")).toBeUndefined();
  });

  it("gives a hotel site's own filters and a store's own sort, as the sites write them", async () => {
    const ostrovok = await lineFor("*", "https://ostrovok.ru/");
    expect(ostrovok).toContain("&type_group=hotel&reviews_rating=8");
    expect(ostrovok).toContain("sort=price.asc");
    expect(await lineFor("*", "https://www.citilink.ru/")).toContain(
      "citilink.ru/search/?text=<words>&sorting=price_asc"
    );
    expect(await lineFor("*", "https://www.ozon.ru/")).toContain(
      "ozon.ru/search/?text=<words>&from_global=true&sorting=price"
    );
  });

  it("has nothing for a site it has no note about, a look-alike host or no site", async () => {
    expect(await lineFor("*", "https://www.rzd.ru/")).toBeUndefined();
    expect(await lineFor("*", "https://nottutu.ru/")).toBeUndefined();
    expect(await lineFor("*", undefined)).toBeUndefined();
    expect(await lineFor("*", "not a url")).toBeUndefined();
  });

  it("goes right after the errand's site, and a task without one is the same as before", () => {
    const options = {
      aliases: [],
      allowPayment: false,
      collectImages: false,
      consent: undefined,
      deliveryAddress: undefined,
      errand: "Три самых дешёвых поезда Москва — Петербург на 8 ноября.",
      facts: undefined,
      home: undefined,
      site: "https://www.tutu.ru",
    };
    const plain = composeBrowserTask(options);
    const noted = composeBrowserTask({
      ...options,
      siteNote: "About this site: note.",
    });
    expect(noted).toContain(
      "Site: https://www.tutu.ru\n\nAbout this site: note.\n\n"
    );
    expect(noted.replace("About this site: note.\n\n", "")).toBe(plain);
    expect(composeBrowserTask({ ...options, siteNote: undefined })).toBe(plain);
  });
});
