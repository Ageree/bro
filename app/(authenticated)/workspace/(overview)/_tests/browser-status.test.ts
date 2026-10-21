import { describe, expect, it } from "vitest";
import { browserErrandsReady } from "@app/(authenticated)/workspace/(overview)/page";

describe("cabinet browser status", () => {
  it("counts the deployment's own browsers without a Browser Use key", () => {
    expect(
      browserErrandsReady({
        BROWSER_BACKEND: "pool",
        BROWSER_USE_API_KEY: undefined,
      })
    ).toBe(true);
  });

  it("needs the Browser Use key on the Browser Use backend", () => {
    expect(
      browserErrandsReady({
        BROWSER_BACKEND: "browser-use",
        BROWSER_USE_API_KEY: undefined,
      })
    ).toBe(false);
  });
});
