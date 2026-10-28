import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Ai from "ai";
import { quickVoiceAnswer } from "@agent/lib/voice/quick";

interface Step {
  readonly toolCalls: readonly { readonly toolName: string }[];
}
interface Options {
  readonly tools: {
    readonly web_search: {
      readonly execute: (input: { query: string }) => Promise<string>;
    };
  };
}

const mocks = vi.hoisted(() => ({
  generateText:
    vi.fn<
      (options: Options) => Promise<{ steps: readonly Step[]; text: string }>
    >(),
  searchWeb:
    vi.fn<
      () => Promise<
        { date: string; snippet: string; title: string; url: string }[]
      >
    >(),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof Ai>()),
  generateText: mocks.generateText,
}));
vi.mock("@agent/lib/model/direct", () => ({
  directModelSelection: () => ({
    model: "test/model",
    modelOptions: { providerOptions: {} },
  }),
}));
vi.mock("@shared/model/provider", () => ({ directModelActive: () => true }));
vi.mock("@db/services/settings", () => ({
  getWorkspaceModelId: async () => await Promise.resolve("test/model"),
}));
vi.mock("@agent/lib/web-search/search", () => ({
  searchWeb: mocks.searchWeb,
}));

const person = {
  now: new Date("2026-10-28T09:00:00Z"),
  timeZone: "Europe/Moscow",
  city: "Москва",
};
let workspace = 0;
/** Each test its own workspace: the limit counts per workspace. */
function scope() {
  workspace += 1;
  return { userId: "u1", workspaceId: `w${String(workspace)}` };
}

const searched = { toolCalls: [{ toolName: "web_search" }] };
const handedOver = { toolCalls: [{ toolName: "to_bro" }] };
const said = { toolCalls: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.searchWeb.mockResolvedValue([
    {
      date: "2 часа назад",
      snippet: "Завтра в Москве +8, облачно",
      title: "Погода Mail.ru",
      url: "https://pogoda.mail.ru",
    },
  ]);
});

describe("the quick answer of /talk", () => {
  it("says what a search found", async () => {
    mocks.generateText.mockResolvedValueOnce({
      steps: [searched, said],
      text: " Завтра около плюс восьми, облачно. ",
    });

    expect(
      await quickVoiceAnswer(scope(), "Какая погода завтра?", person)
    ).toBe("Завтра около плюс восьми, облачно.");
  });

  it("leaves an errand, or a question the search did not answer, to Bro", async () => {
    mocks.generateText.mockResolvedValueOnce({
      steps: [handedOver],
      text: "",
    });
    expect(
      await quickVoiceAnswer(scope(), "Напомни завтра позвонить маме", person)
    ).toBeUndefined();

    mocks.generateText.mockResolvedValueOnce({
      steps: [searched, handedOver],
      text: "",
    });
    expect(
      await quickVoiceAnswer(scope(), "Что нового в новостях?", person)
    ).toBeUndefined();
  });

  it("never says what no search showed", async () => {
    mocks.generateText.mockResolvedValueOnce({
      steps: [said],
      text: "Курс доллара — восемьдесят рублей.",
    });

    expect(
      await quickVoiceAnswer(scope(), "Какой курс доллара?", person)
    ).toBeUndefined();
  });

  it("hands the words to Bro when the model fails", async () => {
    mocks.generateText.mockRejectedValueOnce(new Error("timeout"));

    expect(
      await quickVoiceAnswer(scope(), "Какая погода завтра?", person)
    ).toBeUndefined();
  });

  it("gives the pages with the rule to hand over in the language asked", async () => {
    mocks.generateText.mockResolvedValue({ steps: [searched], text: "" });

    await quickVoiceAnswer(
      scope(),
      "What's the weather tomorrow?\n(ты: «Сейчас посмотрю»)",
      person
    );
    const english =
      await mocks.generateText.mock.calls[0]?.[0].tools.web_search.execute({
        query: "weather",
      });
    expect(english).toContain("Завтра в Москве +8");
    expect(english).toContain("to_bro");
    expect(english).toContain("not in Russian");

    await quickVoiceAnswer(scope(), "Какая погода завтра?", person);
    const russian =
      await mocks.generateText.mock.calls[1]?.[0].tools.web_search.execute({
        query: "погода",
      });
    expect(russian).toContain("по-русски");
  });

  it("sends a workspace's words to Bro past twenty quick answers in five minutes", async () => {
    mocks.generateText.mockResolvedValue({
      steps: [searched, said],
      text: "Плюс восемь.",
    });
    const own = scope();
    for (let index = 0; index < 20; index += 1)
      // oxlint-disable-next-line eslint/no-await-in-loop -- One after another, as the page asks.
      await quickVoiceAnswer(own, "Какая погода?", person);

    expect(
      await quickVoiceAnswer(own, "Какая погода?", person)
    ).toBeUndefined();
    expect(mocks.generateText).toHaveBeenCalledTimes(20);
  });
});
