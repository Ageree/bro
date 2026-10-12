import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@agent/lib/yandex/operations";
import { accountReadyOperation, readinessReply } from "@agent/lib/yandex/ready";
import { type FakeResponse, dataOf, fixture, runInPage } from "./page";

const userId = "0123456789abcdef0123456789abcdef";

const visa = {
  id: "card-x1a",
  number: "****4310",
  system: "VISA",
  title: "VISA •••• 4310",
};
const mir = { id: "card-x2b", number: "****6443", title: "Мир •••• 6443" };

/** Go's page, answering its own requests by path. */
async function goPage(methods: FakeResponse) {
  const answers = new Map<string, FakeResponse>([
    ["/csrf_token", { body: await fixture("go/csrf-token.json") }],
    ["/3.0/paymentmethods", methods],
  ]);
  const paths: string[] = [];
  return {
    paths,
    page: {
      indexedDb: { userId },
      origin: "https://taxi.yandex.ru/",
      respond(url: URL, init: { body?: string | null }) {
        paths.push(url.pathname);
        z.json().parse(JSON.parse(init.body ?? "null"));
        return answers.get(url.pathname) ?? { body: {}, status: 404 };
      },
    },
  };
}

async function ready(methods: FakeResponse) {
  const { page, paths } = await goPage(methods);
  const answer = await runInPage(accountReadyOperation.run, {}, page);
  return { answer, paths };
}

describe("yandex account.ready", () => {
  it("lists the account's cards and which Go holds back, reading nothing else", async () => {
    const { answer, paths } = await ready({
      body: { card: { available_cards: [visa, mir], unverified_cards: [mir] } },
    });
    const data: JsonValue = dataOf(answer);
    expect(accountReadyOperation.result.parse(data)).toEqual({
      cards: [
        {
          id: "card-x1a",
          last4: "4310",
          title: "VISA •••• 4310",
          verified: true,
        },
        {
          id: "card-x2b",
          last4: "6443",
          title: "Мир •••• 6443",
          verified: false,
        },
      ],
      signedIn: true,
    });
    expect(paths).toEqual(["/csrf_token", "/3.0/paymentmethods"]);
  });

  it("names an unverified card Go lists only as held back, and skips hidden ones", async () => {
    const { answer } = await ready({
      body: {
        card: {
          available_cards: [{ ...visa, is_hidden: true }],
          unverified_cards: [mir],
        },
      },
    });
    expect(dataOf(answer)).toEqual({
      cards: [
        {
          id: "card-x2b",
          last4: "6443",
          title: "Мир •••• 6443",
          verified: false,
        },
      ],
      signedIn: true,
    });
  });

  it("answers signed_out when Go says nobody is signed in", async () => {
    const { answer } = await ready({ body: {}, status: 401 });
    expect(answer).toEqual({ status: "signed_out" });
  });
});

const card = (verified: boolean) => ({
  id: "card-x2b",
  last4: "6443",
  title: "Мир •••• 6443",
  verified,
});

describe("what account.ready tells the model to do next", () => {
  it("goes on with the errand when a card works", () => {
    const reply = readinessReply(
      {
        cards: [card(false), { ...card(true), id: "card-x1a" }],
        signedIn: true,
      },
      { canVerify: true }
    );
    expect(reply).toContain("Ready");
    expect(reply).not.toContain("verify_card");
  });

  it("asks before the bank's link and names the card to verify", () => {
    const reply = readinessReply(
      { cards: [card(false)], signedIn: true },
      { canVerify: true }
    );
    expect(reply).toContain("Only after their yes");
    expect(reply).toContain("verify_card and cardId card-x2b");
    expect(reply).toContain("never open the link yourself");
  });

  it("sends the person to the Go app when Bro cannot make the link", () => {
    const reply = readinessReply(
      { cards: [card(false)], signedIn: true },
      { canVerify: false }
    );
    expect(reply).toContain("Yandex Go app");
    expect(reply).not.toContain("verify_card");
  });

  it("explains where to link a card and never takes its number in the chat", () => {
    const reply = readinessReply(
      { cards: [], signedIn: true },
      { canVerify: true }
    );
    expect(reply).toContain("no bank card is linked");
    expect(reply).toContain("Never ask for the card number");
  });

  it("does not guess when the cards could not be read", () => {
    expect(
      readinessReply({ error: "http_500" }, { canVerify: true })
    ).toContain("Do not guess");
  });
});
