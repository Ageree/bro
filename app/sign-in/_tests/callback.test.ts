import { describe, expect, it } from "vitest";
import { ownCallbackUrl } from "@app/sign-in/_lib/callback";

describe("sign-in callback", () => {
  it("returns to a path on this site", () => {
    expect(ownCallbackUrl("/chat?session=1")).toBe("/chat?session=1");
  });

  it.each(["//evil.example", "/\\evil.example", "https://evil.example"])(
    "sends «%s» to the cabinet",
    (requested) => {
      expect(ownCallbackUrl(requested)).toBe("/workspace");
    }
  );
});
