import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Ai from "ai";
import { quickVoiceAnswer } from "@agent/lib/voice/quick";

interface Options {
  readonly tools: {
    readonly web_search: {
      readonly execute: (input: { query: string }) => Promise<string>;
    };
  };
}
interface Answered {
  readonly steps: readonly {
    readonly toolCalls: readonly { readonly toolName: string }[];
  }[];
  readonly text: string;
}
interface Page {
  readonly date: string;
  readonly snippet: string;
  readonly title: string;
  readonly url: string;
}

const mocks = vi.hoisted(() => ({
  generateText: vi.fn<(options: Options) => Promise<Answered>>(),
  searchWeb: vi.fn<() => Promise<Page[]>>(),
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

/** The model searches, reads what the search tool gave it, then writes `text`. */
function searchesThenSays(text: string, read: string[] = []) {
  mocks.generateText.mockImplementationOnce(async (options) => {
    read.push(await options.tools.web_search.execute({ query: "погода" }));
    return { steps: [searched, said], text };
  });
}

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
  it("says what a search found, as one line", async () => {
    searchesThenSays(" Завтра около плюс восьми,\nоблачно. ");

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
      await quickVoiceAnswer(scope(), "Что у меня завтра в календаре?", person)
    ).toBeUndefined();

    mocks.generateText.mockResolvedValueOnce({
      steps: [searched, handedOver],
      text: "",
    });
    expect(
      await quickVoiceAnswer(scope(), "Что нового в новостях?", person)
    ).toBeUndefined();
  });

  it("hands words with an errand to Bro without asking the model", async () => {
    expect(
      await quickVoiceAnswer(
        scope(),
        "Какая завтра погода? Если дождь — напомни взять зонт",
        person
      )
    ).toBeUndefined();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("never says what no search showed", async () => {
    mocks.generateText.mockResolvedValueOnce({
      steps: [said],
      text: "Курс доллара — восемьдесят рублей.",
    });
    expect(
      await quickVoiceAnswer(scope(), "Какой курс доллара?", person)
    ).toBeUndefined();

    // A search that failed stands behind nothing the model writes after it.
    mocks.searchWeb.mockRejectedValueOnce(new Error("timeout"));
    const read: string[] = [];
    searchesThenSays("Не удалось найти, но обычно около восьмидесяти.", read);
    expect(
      await quickVoiceAnswer(scope(), "Какой курс доллара?", person)
    ).toBeUndefined();
    expect(read[0]).toContain("to_bro");
  });

  it("hands the words to Bro when the model fails", async () => {
    mocks.generateText.mockRejectedValueOnce(new Error("timeout"));

    expect(
      await quickVoiceAnswer(scope(), "Какая погода завтра?", person)
    ).toBeUndefined();
  });

  it("gives the pages with the rule to hand over in the language asked", async () => {
    const english: string[] = [];
    searchesThenSays("Tomorrow, plus eight.", english);
    await quickVoiceAnswer(
      scope(),
      "(ты: «Нашёл три отеля в Лондоне.»)\nWhat's the weather tomorrow?",
      person
    );
    expect(english[0]).toContain("Завтра в Москве +8");
    expect(english[0]).toContain("to_bro");
    expect(english[0]).toContain("not in Russian");

    const russian: string[] = [];
    searchesThenSays("Плюс восемь.", russian);
    await quickVoiceAnswer(scope(), "Какая погода завтра?", person);
    expect(russian[0]).toContain("по-русски");
  });

  it("sends a workspace's words to Bro past twenty quick answers in five minutes", async () => {
    mocks.generateText.mockResolvedValue({
      steps: [said],
      text: "",
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
