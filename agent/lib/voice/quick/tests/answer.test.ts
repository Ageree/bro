import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Ai from "ai";
import { quickVoiceAnswer } from "@agent/lib/voice/quick/answer";
import type * as Remind from "@agent/lib/voice/quick/remind";

/** A part of a tool's call or result that the quick answer hands the model. */
interface HandedPart {
  readonly output?: { readonly value: string };
  readonly type: string;
}
interface Options {
  // The person's words, then any home data as tools' calls and results.
  readonly messages: readonly [
    { readonly content: string },
    ...{ readonly content: readonly HandedPart[] }[],
  ];
  readonly tools: {
    readonly remind: {
      readonly execute: (input: {
        text: string;
        inMinutes?: number;
      }) => Promise<string>;
    };
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
  findPlaces:
    vi.fn<() => Promise<{ label: string; lat: number; lon: number }[]>>(),
  generateText: vi.fn<(options: Options) => Promise<Answered>>(),
  officialRateLines: vi.fn<() => Promise<{ lines: string; quoted: number }>>(),
  searchWeb: vi.fn<() => Promise<Page[]>>(),
  remindOnce: vi.fn<() => Promise<string>>(),
  weatherAt: vi.fn<() => Promise<string>>(),
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
vi.mock("@agent/lib/voice/quick/remind", async (importOriginal) => ({
  ...(await importOriginal<typeof Remind>()),
  remindOnce: mocks.remindOnce,
}));
vi.mock("@agent/lib/routes/openstreetmap", () => ({
  findPlaces: mocks.findPlaces,
}));
vi.mock("@agent/lib/weather/metno", () => ({
  placeZone: () => "Europe/Moscow",
  weatherAt: mocks.weatherAt,
}));
vi.mock("@agent/lib/rates/cbr", () => ({
  officialRateLines: mocks.officialRateLines,
}));

const person = {
  now: new Date("2026-10-28T09:00:00Z"),
  timeZone: "Europe/Moscow",
  city: "Москва",
  chat: undefined,
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
  // A queued answer a test left unused must not reach the next one.
  vi.resetAllMocks();
  mocks.searchWeb.mockResolvedValue([
    {
      date: "2 часа назад",
      snippet: "Завтра в Москве +8, облачно",
      title: "Погода Mail.ru",
      url: "https://pogoda.mail.ru",
    },
  ]);
  mocks.findPlaces.mockResolvedValue([
    { label: "Москва", lat: 55.75, lon: 37.62 },
  ]);
  mocks.weatherAt.mockResolvedValue(
    "Завтра, четверг, 29 октября: днём от +4° до +10°, пасмурно, без осадков, ветер до 3 м/с."
  );
  mocks.officialRateLines.mockResolvedValue({
    lines: "Курс ЦБ РФ на 28.10.2026:\nUSD — Доллар США: 80 руб. 53 коп.",
    quoted: 1,
  });
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

  it("says a reminder it set as the line made for it, with no step after", async () => {
    mocks.remindOnce.mockResolvedValueOnce(
      "Поставил напоминание завтра в 09:00: позвонить маме. Придёт в Telegram."
    );
    mocks.generateText.mockImplementationOnce(async (options) => {
      await options.tools.remind.execute({ text: "позвонить маме" });
      return { steps: [{ toolCalls: [{ toolName: "remind" }] }], text: "" };
    });

    expect(
      await quickVoiceAnswer(
        scope(),
        "Напомни завтра в девять позвонить маме",
        person
      )
    ).toBe(
      "Поставил напоминание завтра в 09:00: позвонить маме. Придёт в Telegram."
    );
  });

  it("hands a reminder it may not set to Bro", async () => {
    const { RemindRefusal } = await vi.importActual<typeof Remind>(
      "@agent/lib/voice/quick/remind"
    );
    mocks.remindOnce.mockRejectedValueOnce(new RemindRefusal("no time"));
    mocks.generateText.mockImplementationOnce(async (options) => {
      await options.tools.remind.execute({ text: "позвонить маме" });
      return { steps: [{ toolCalls: [{ toolName: "remind" }] }], text: "" };
    });

    expect(
      await quickVoiceAnswer(
        scope(),
        "Напомни завтра в девять позвонить маме",
        person
      )
    ).toBeUndefined();
  });

  it("hands a reminder with a condition or a question beside it to Bro whole, without the model", async () => {
    expect(
      await quickVoiceAnswer(
        scope(),
        "Какая завтра погода? Если дождь — напомни взять зонт",
        person
      )
    ).toBeUndefined();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("hands words with an errand to Bro without asking the model", async () => {
    expect(
      await quickVoiceAnswer(
        scope(),
        "Какая завтра погода? Если дождь — закажи такси к восьми",
        person
      )
    ).toBeUndefined();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("never says what no search showed", async () => {
    // Nor the bank: no rates handed over before the question.
    mocks.officialRateLines.mockRejectedValue(
      new Error("The bank answered 503")
    );
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

  it("hands the words to Bro when the model only says the pages hold no answer", async () => {
    searchesThenSays("В выдержках нет конкретных новостей, только заголовки.");

    expect(
      await quickVoiceAnswer(scope(), "Что нового в новостях?", person)
    ).toBeUndefined();
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

  /** What the model is handed besides the person's words: the home data's results, as tools' would be. */
  function askHanded(words: string) {
    let handed = "";
    mocks.generateText.mockImplementationOnce(async (options) => {
      const [, ...data] = options.messages;
      handed = data
        .flatMap((message) =>
          message.content.map((part) => part.output?.value ?? part.type)
        )
        .join("\n");
      return await Promise.resolve({
        steps: [said],
        text: "Доллар сегодня 80 рублей 53 копейки.",
      });
    });
    return async () => {
      const answer = await quickVoiceAnswer(scope(), words, person);
      return { answer, handed };
    };
  }

  it("answers the home weather or rates in one call, handed the data read before the question", async () => {
    const dollar = await askHanded("Сколько стоит доллар?")();
    expect(dollar.answer).toBe("Доллар сегодня 80 рублей 53 копейки.");
    expect(dollar.handed).toContain("USD — Доллар США: 80 руб. 53 коп.");
    expect(dollar.handed).not.toContain("MET Norway");

    const weather = await askHanded("Какая завтра погода?")();
    expect(weather.handed).toContain("Прогноз MET Norway для Москва");
  });

  it("hands no home data to another question, another city or a day past the week", async () => {
    // With the data in the instructions, a week of degrees held nearly every small number (review 28.10).
    for (const words of [
      "Сколько будет 2 плюс 2?",
      "Какая погода в Казани завтра?",
      "Какая погода будет в следующую пятницу?",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One question after another.
      const { answer, handed } = await askHanded(words)();
      expect(handed).toBe("");
      // An answer with nothing behind it goes to Bro.
      expect(answer).toBeUndefined();
    }
  });

  it("asks the model without the home data that is not read in time", async () => {
    mocks.officialRateLines.mockImplementation(
      async () => await new Promise(() => undefined)
    );

    const { answer, handed } = await askHanded("Сколько стоит доллар?")();

    expect(handed).toBe("");
    expect(answer).toBeUndefined();
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
