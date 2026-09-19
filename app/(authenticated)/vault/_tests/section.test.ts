import { describe, expect, it } from "vitest";
import { answerVaultSectionQuery } from "@app/(authenticated)/vault/_components/section";

const cardSetup = { kind: "payment" as const };

describe("vault section query", () => {
  it("opens the sheet a link asked for, with what it said about the item", () => {
    expect(
      answerVaultSectionQuery("setup=vault&kind=payment", {
        setup: cardSetup,
        view: "add",
      })
    ).toEqual({ open: true, setup: cardSetup, view: "add" });
  });

  it("keeps the sheet as it is once the query has been taken off the URL", () => {
    expect(answerVaultSectionQuery("", { view: "list" })).toBeUndefined();
  });

  it("closes this section when the query names another one", () => {
    expect(answerVaultSectionQuery("add=login", { view: "list" })).toEqual({
      open: false,
      setup: undefined,
      view: "list",
    });
  });
});
