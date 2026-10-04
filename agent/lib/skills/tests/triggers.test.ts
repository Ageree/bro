import type { ModelMessage } from "ai";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SkillName } from "@agent/lib/skills/catalog";
import { caseTurns } from "../../../../scripts/bench/cases";

// The triggers read nothing but their input: the database is not there.
vi.mock("@db", () => {
  throw new Error("Skill triggers must not reach the database.");
});

const { skillsForTurn } = await import("@agent/lib/skills/triggers");

function said(text: string): ModelMessage {
  return { content: text, role: "user" };
}

function skillsFor(text: string, history: readonly ModelMessage[] = []) {
  return skillsForTurn({ browserReport: false, history, input: [said(text)] });
}

/** A message of the person's with a file of this type, as the web sends. */
function sent(mediaType: string): ModelMessage {
  return {
    content: [
      { text: "глянь", type: "text" },
      { data: "AAAA", filename: "plan", mediaType, type: "file" },
    ],
    role: "user",
  };
}

/** An assistant's step that called these tools with these inputs. */
function called(
  ...calls: readonly (readonly [string, object])[]
): ModelMessage {
  return {
    content: calls.map(([toolName, input], index) => ({
      input,
      toolCallId: `call-${String(index)}`,
      toolName,
      type: "tool-call" as const,
    })),
    role: "assistant",
  };
}

/** What `browser_task` returned to a step. */
function browserReturned(text: string): ModelMessage {
  return {
    content: [
      {
        output: { type: "json", value: { report: text } },
        toolCallId: "call-0",
        toolName: "browser_task",
        type: "tool-result",
      },
    ],
    role: "tool",
  };
}

const turns = await caseTurns();
const texts = new Map(turns.map(({ id, text }) => [id, text]));

/**
 * What each benchmark message attaches (docs/benchmarks, as `caseTurns`
 * delivers it). Accepted false positives lean to recall: a company in the
 * news attaches the browser, a dentist public services, «card» money.
 */
const golden = {
  "d01-online-task": ["browser"],
  "d02-flights": ["browser", "schedules"],
  "d03-recommendations": ["recommendations"],
  "d04-marketplace": ["browser", "memory"],
  "d05-groceries": ["browser"],
  "d06-gosuslugi": ["browser", "gov-services"],
  "d07-doctor": ["browser", "gov-services"],
  "d08-utilities": ["browser", "gov-services", "meter-readings"],
  "d09-email": ["google", "memory"],
  "d12-routine": ["google", "schedules"],
  "d13-memory#1": ["browser", "memory"],
  "d13-memory#2": ["browser", "recommendations"],
  "d13-memory#3": ["browser", "recommendations"],
  "d14-permissions#1": ["money"],
  "d14-permissions#2": ["google", "money"],
  "d14-permissions#3": ["google", "apps"],
  "d14-permissions#4": ["google", "about-bro"],
  "d14-permissions#5": ["memory"],
  "d15-language#1": ["browser", "google", "schedules"],
  "d15-language#2": [],
  "d15-language#3": [],
  "d15-language#4": ["google"],
  "d16-calls": ["recommendations"],
  "d17-groups": ["browser", "recommendations"],
  "d18-chain": ["browser", "gov-services", "google", "apps"],
  "uc-tr-hotel": ["browser", "recommendations"],
  "uc-tr-taxi-airport": ["browser"],
  "uc-tr-train-exchange": ["browser"],
  "uc-tr-family-flights": ["browser"],
  "uc-tr-kaliningrad": ["browser", "recommendations", "money"],
  "uc-tr-entry-rules": ["browser", "gov-services", "google"],
  "uc-tr-refund": ["browser", "money"],
  "uc-tr-lost-baggage": [],
  "uc-mo-subscriptions": ["browser", "google", "money", "schedules"],
  "uc-mo-tax-deduction": ["browser", "gov-services"],
  "uc-mo-split": ["money"],
  "uc-mo-internet-bill": ["google", "money", "schedules"],
  "uc-mo-receipts": ["google"],
  "uc-mo-cards-abroad": ["money"],
  "uc-mo-osago": ["browser"],
  "uc-mo-autopay": ["browser", "money"],
  "uc-ho-meters-monthly": [
    "browser",
    "gov-services",
    "meter-readings",
    "schedules",
    "images",
  ],
  "uc-ho-plumber": ["browser", "recommendations"],
  "uc-ho-kid-club": ["recommendations", "schedules"],
  "uc-ho-gift-mom": ["browser", "recommendations"],
  "uc-ho-provider": ["browser"],
  "uc-ho-avito-sell": ["browser", "images"],
  "uc-ho-water-outage": [],
  "uc-ma-inbox-cleanup": ["browser", "google"],
  "uc-ma-event-from-photo": ["google"],
  "uc-ma-yandex-mail": ["google", "apps"],
  "uc-ma-meeting-followup": ["browser", "google"],
  "uc-ma-telemost": ["browser", "google", "apps"],
  "uc-sh-return-wb": ["browser"],
  "uc-sh-cdek": ["browser"],
  "uc-sh-pochta": ["browser"],
  "uc-sh-compare": ["browser", "recommendations"],
  "uc-sh-price-watch": ["browser", "schedules"],
  "uc-sh-furniture": ["browser"],
  "uc-sh-lunch": ["browser"],
  "uc-sh-avito-buy": ["browser"],
  "uc-wo-hh": ["browser"],
  "uc-wo-company-brief": ["browser", "schedules"],
  "uc-wo-self-employed": ["browser", "gov-services"],
  "uc-wo-tg-digest": [],
  "uc-wo-business-trip": ["browser", "recommendations", "google"],
  "uc-go-zagran": ["browser", "gov-services"],
  "uc-go-passport-45": ["browser", "gov-services"],
  "uc-go-fines-watch": ["browser", "gov-services", "money", "schedules"],
  "uc-go-no-criminal": ["browser", "gov-services"],
  "uc-go-temp-registration": ["browser", "gov-services"],
  "uc-go-docs-expiry": ["browser", "gov-services", "google", "schedules"],
  "uc-he-dms": ["browser", "gov-services", "recommendations"],
  "uc-he-pharmacy": ["browser", "recommendations"],
  "uc-he-lab-tests": ["browser", "gov-services"],
  "uc-he-results": ["browser", "gov-services", "google"],
  "uc-he-kid-pediatrician": ["browser", "gov-services"],
  "uc-he-vet": ["browser", "recommendations"],
  "uc-en-weekend": ["recommendations"],
  "uc-en-tickets": ["browser", "recommendations"],
  "uc-en-cinema": ["recommendations"],
  "uc-en-banya": ["browser", "recommendations"],
  "uc-en-kid-party": ["browser", "recommendations"],
  "uc-en-watch": ["recommendations"],
  "uc-en-card-quiz": ["images", "games"],
  "en:d03_reco": ["recommendations"],
  "en:d16_content": ["images", "games"],
  "en:d07_routine": ["google", "schedules"],
  "en:d10_mem_a": ["memory"],
  "en:d12_phone": ["recommendations"],
  "en:d01_online_task": ["browser", "recommendations"],
  "en:d02_travel": ["browser", "schedules"],
  "en:d04_purchase": ["browser", "memory"],
  "en:d08_integrations": ["google", "apps"],
  "en:d13_group": ["browser", "recommendations"],
  "en:d05_email": ["google", "memory"],
  "en:d14_chain": ["browser", "gov-services", "google"],
  "en:uc_add_event": ["google"],
  "en:uc_visa": ["browser", "gov-services", "google", "images"],
  "en:uc_dentist": ["browser", "gov-services", "recommendations", "google"],
  "en:uc_points": ["browser", "money"],
  "en:uc_hotel": ["browser", "recommendations"],
  "en:uc_dmv": ["browser", "gov-services", "recommendations", "google"],
  "en:uc_family_flights": ["browser"],
  "en:uc_tracker": ["browser", "about-bro"],
  "en:uc_deck": ["money"],
  "en:uc_drop": ["browser", "money", "schedules", "images", "about-bro"],
  "en:uc_conflicts": ["google", "schedules"],
  "en:uc_missing_delivery": ["browser"],
  "en:uc_checkin": ["browser", "schedules"],
  "en:uc_junk": ["google"],
  "en:uc_intake": ["browser", "money", "schedules"],
  "en:uc_group_meeting": ["google", "schedules"],
  "en:uc_energy": ["browser", "gov-services", "meter-readings"],
  "en:uc_company_brief": ["schedules"],
  "en:uc_apartment": ["browser"],
  "en:uc_webinars": ["browser", "schedules"],
  "en:uc_recurring": ["money", "schedules"],
  "en:uc_remodel": ["schedules"],
  "en:uc_payments_sheet": ["google", "apps", "money", "files"],
  "en:uc_meme_edit": ["images"],
  "en:uc_followups": ["google", "apps", "schedules"],
  "en:uc_brief_telegram": ["apps", "schedules"],
  "en:uc_morning_drafts": ["google", "schedules"],
  "en:uc_ikea": ["browser"],
  "en:uc_lunch": ["browser", "recommendations", "memory"],
  "en:uc_call_friend": [],
  "en:uc_study": ["games"],
  "en:uc_trip": ["browser", "recommendations"],
  "en:uc_kindle": ["google"],
  "en:uc_car": ["browser", "recommendations"],
  "en:uc_reorder": ["browser", "money"],
  "en:uc_claims": ["recommendations", "money", "schedules"],
  "en:uc_content_desk": ["apps", "schedules"],
  "en:uc_launch_day": ["browser", "google", "apps", "schedules", "about-bro"],
  "en:uc_chief_of_staff": ["memory", "schedules"],
  "en:uc_fax": ["browser"],
  "en:uc_ads_sheet": ["google", "apps", "schedules", "images"],
  "en:uc_ads_rule": ["images"],
  "en:uc_outreach": ["google", "apps", "schedules"],
  "en:uc_kids": ["recommendations", "google", "schedules"],
  "en:uc_sell_tickets": ["browser", "google", "schedules", "games"],
  "en:uc_guardrails": ["google", "about-bro"],
  "en:uc_ship": [],
  "en:uc_insurance": ["browser"],
  "en:uc_voice": [],
  "en:uc_triage": ["google", "memory"],
  "en:uc_fares": ["browser", "schedules"],
  "en:uc_watch_x": ["schedules"],
  "en:uc_refund": ["google", "money"],
} satisfies Record<string, readonly SkillName[]>;

const synthetic = [
  [
    "photos-only",
    "[фото]\n[фото]\n[фото]",
    ["browser", "gov-services", "meter-readings"],
  ],
  [
    "photos-vot",
    "[фото]\n[фото] вот, передай",
    ["browser", "gov-services", "meter-readings"],
  ],
  ["photo-calendar", "[фото] добавь в календарь", ["google"]],
  // A product pick needs the rules of picking at once, not a step later.
  [
    "product-pick",
    "Привет! Найди мне хороший крем для рук",
    ["recommendations"],
  ],
  ["product-pick-short", "подыщи недорогой увлажнитель", ["recommendations"]],
  ["find-mail", "найди письмо от Пети про счёт", ["google"]],
  // Paraphrases of risky errands the benchmark does not word this way.
  ["sts", "пробей по СТС А123ВС77", ["browser", "gov-services"]],
  [
    "license",
    "проверь по водительскому 7700123456",
    ["browser", "gov-services"],
  ],
  ["transfer", "переведи Пете 3000", ["browser", "money"]],
  ["top-up", "закинь 500 на телефон", ["browser", "money"]],
  ["troika", "пополни тройку", ["browser", "money"]],
  ["card", "добавь карту", ["money"]],
  ["pizza", "хочу пиццу домой", ["browser"]],
  ["translation", "переведи на английский этот текст", []],
  ["file-photo", "[файл: photo.jpg (image/jpeg), слишком большой]", []],
  ["document", "[документ] глянь", []],
  ["privacy-third", "вы передаёте мою переписку третьим лицам?", ["about-bro"]],
  ["privacy-en", "do you share my data with anyone?", ["about-bro"]],
  ["forget-address", "удали мой адрес", ["memory"]],
  ["standing", "заказывай такси сам, не спрашивая", ["browser", "money"]],
  [
    "launch-login",
    "here is our login, post the replies",
    ["browser", "google", "about-bro"],
  ],
  [
    "google-left",
    "что у тебя осталось после отключения?",
    ["google", "about-bro"],
  ],
  [
    "sheets",
    "add these payments to my budgeting spreadsheet",
    ["google", "apps", "money", "files"],
  ],
  // Undoing a permission or a schedule must find its tool, which follows
  // its skill (`agent/lib/skills/tools.ts`).
  [
    "permission-revoke",
    "спрашивай меня снова, прежде чем записывать",
    ["money"],
  ],
  [
    "permission-revoke-en",
    "ask me again before you book",
    ["browser", "money"],
  ],
  ["schedule-stop", "больше не присылай сводку", ["schedules"]],
  ["schedule-stop-tired", "хватит присылать мне погоду", ["schedules"]],
  ["schedule-stop-en", "stop sending me the morning brief", ["schedules"]],
  ["schedule-cancel", "хватит, отмени эту сводку", ["schedules"]],
  ["schedule-remove", "убери утреннюю сводку", ["schedules"]],
  ["schedule-no-more", "не надо больше присылать новости", ["schedules"]],
  ["schedule-no-longer", "больше не надо присылать погоду", ["schedules"]],
  ["no-more-thanks", "мне больше не надо, спасибо", []],
  ["schedule-quit", "перестань мне писать про погоду", ["schedules"]],
  ["schedule-cancel-en", "cancel my morning brief", ["schedules"]],
  ["schedule-move", "перенеси сводку на 8", ["google", "schedules"]],
  ["reminder-wake", "разбуди меня завтра в 7", ["schedules"]],
  ["reminder-nudge", "через час пни меня насчёт отчёта", ["schedules"]],
  ["reminder-tell", "в 6 вечера скажи мне позвонить маме", ["schedules"]],
  ["calendar-add", "добавь на пятницу ужин с мамой", ["google"]],
  ["calendar-move-en", "Move my 3pm to 4", ["google"]],
  ["calendar-push-en", "push the sync with Anna to Friday", ["google"]],
  [
    "esia-report",
    "RESULT: экран esia.gosuslugi.ru «Предоставление прав доступа», NEEDS: decision",
    ["browser", "gov-services"],
  ],
] as const satisfies readonly (readonly [
  string,
  string,
  readonly SkillName[],
])[];

const required = {
  browser: [
    "d01-online-task",
    "d02-flights",
    "d04-marketplace",
    "d05-groceries",
    "d06-gosuslugi",
    "d07-doctor",
    "d08-utilities",
    "d13-memory#2",
    "d13-memory#3",
    "d15-language#1",
    "d17-groups",
    "d18-chain",
    "uc-tr-hotel",
    "uc-tr-taxi-airport",
    "uc-tr-train-exchange",
    "uc-tr-family-flights",
    "uc-tr-kaliningrad",
    "uc-tr-refund",
    "uc-mo-tax-deduction",
    "uc-mo-osago",
    "uc-mo-autopay",
    "uc-ho-meters-monthly",
    "uc-ho-plumber",
    "uc-ho-gift-mom",
    "uc-ho-provider",
    "uc-ho-avito-sell",
    "uc-ma-inbox-cleanup",
    "uc-ma-telemost",
    "uc-sh-return-wb",
    "uc-sh-cdek",
    "uc-sh-pochta",
    "uc-sh-compare",
    "uc-sh-price-watch",
    "uc-sh-furniture",
    "uc-sh-lunch",
    "uc-sh-avito-buy",
    "uc-wo-hh",
    "uc-wo-self-employed",
    "uc-wo-business-trip",
    "uc-go-zagran",
    "uc-go-passport-45",
    "uc-go-fines-watch",
    "uc-go-no-criminal",
    "uc-go-temp-registration",
    "uc-go-docs-expiry",
    "uc-he-dms",
    "uc-he-pharmacy",
    "uc-he-lab-tests",
    "uc-he-kid-pediatrician",
    "uc-he-vet",
    "uc-en-tickets",
    "uc-en-banya",
    "uc-en-kid-party",
    "en:d01_online_task",
    "en:d02_travel",
    "en:d04_purchase",
    "en:d13_group",
    "en:d14_chain",
    "en:uc_visa",
    "en:uc_dentist",
    "en:uc_points",
    "en:uc_hotel",
    "en:uc_dmv",
    "en:uc_family_flights",
    "en:uc_drop",
    "en:uc_missing_delivery",
    "en:uc_checkin",
    "en:uc_intake",
    "en:uc_energy",
    "en:uc_apartment",
    "en:uc_webinars",
    "en:uc_ikea",
    "en:uc_lunch",
    "en:uc_trip",
    "en:uc_car",
    "en:uc_reorder",
    "en:uc_fax",
    "en:uc_sell_tickets",
    "en:uc_insurance",
    "en:uc_fares",
  ],
  "gov-services": [
    "d06-gosuslugi",
    "d07-doctor",
    "d08-utilities",
    "uc-mo-tax-deduction",
    "uc-ho-meters-monthly",
    "uc-wo-self-employed",
    "uc-go-zagran",
    "uc-go-passport-45",
    "uc-go-fines-watch",
    "uc-go-no-criminal",
    "uc-go-temp-registration",
    "uc-go-docs-expiry",
    "uc-he-dms",
    "uc-he-lab-tests",
    "uc-he-kid-pediatrician",
    "en:uc_visa",
    "en:uc_dentist",
    "en:uc_dmv",
    "en:uc_energy",
  ],
  "meter-readings": ["d08-utilities", "uc-ho-meters-monthly", "en:uc_energy"],
  money: [
    "d14-permissions#1",
    "d14-permissions#2",
    "en:uc_points",
    "en:uc_drop",
    "en:uc_reorder",
    "en:uc_claims",
  ],
} satisfies Partial<Record<SkillName, readonly string[]>>;

describe("the skills a turn attaches", () => {
  it("cover every benchmark message as pinned", () => {
    expect(
      Object.fromEntries(turns.map(({ id, text }) => [id, skillsFor(text)]))
    ).toEqual(golden);
  });

  it.each(Object.entries(required))(
    "never miss %s where a benchmark message needs it",
    (skill, ids) => {
      const missed = ids.filter(
        (id) => !skillsFor(texts.get(id) ?? "").some((name) => name === skill)
      );
      expect(missed).toEqual([]);
    }
  );

  it.each(synthetic)("attach what %s needs", (_name, text, skills) => {
    expect(skillsFor(text)).toEqual(skills);
  });

  it("spell a letter so that JavaScript knows Cyrillic", () => {
    // `\w` and `\b` are ASCII in JavaScript: «подарок» would not start a word.
    const source = readFileSync(
      new URL("../triggers.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(/\\[wWbB]/u);
  });

  it("come out the same for the same turn", () => {
    for (const { text } of turns) {
      expect(skillsFor(text)).toEqual(skillsFor(text));
    }
  });

  it("read a voice message's transcript, not the media notes", () => {
    expect(skillsFor("[голосовое] запиши меня к терапевту на пятницу")).toEqual(
      ["browser", "gov-services"]
    );
    expect(
      skillsFor("[файл: photo.jpg (image/jpeg), не удалось скачать]")
    ).toEqual([]);
    expect(skillsFor("[документ]\n[голосовое не распозналось]")).toEqual([]);
  });

  it("give a document for the task agent, or its marker, the rules for files", () => {
    for (const text of [
      "[файл: отчёт (1).xlsx (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet)]",
      "посчитай итог\n[файл: продажи, март.csv (text/csv)]",
      // One that did not come through: Bro says so.
      "[файл: архив.zip (application/zip)]",
      "[файл: смета.xlsx (application/vnd.ms-excel), слишком большой]",
    ]) {
      expect(skillsFor(text)).toContain("files");
    }
    // A picture or a PDF the model reads itself.
    for (const text of [
      "[файл: счёт.pdf (application/pdf)]",
      "[файл: фото (1).jpg (image/jpeg)]",
      "[файл: photo.jpg (image/jpeg), слишком большой]",
    ]) {
      expect(skillsFor(text)).not.toContain("files");
    }
    const filesFor = (mediaType: string) =>
      skillsForTurn({
        browserReport: false,
        history: [],
        input: [sent(mediaType)],
      }).includes("files");
    expect(
      filesFor(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
    ).toBe(true);
    expect(filesFor("image/png")).toBe(false);
    expect(filesFor("application/pdf")).toBe(false);
  });

  it("give decks, tables and charts the rules for files", () => {
    for (const text of [
      "сделай презентацию на пять слайдов",
      "сведи в таблицу и построй график",
      "make a pitch deck about us",
      "convert this to xlsx",
      "нарисуй график",
      "построй мне график расходов",
      "график продаж по месяцам",
    ]) {
      expect(skillsFor(text)).toContain("files");
    }
    for (const text of [
      // «График» is a schedule too.
      "скинь график дежурств на неделю",
      "какой у тебя график работы?",
      "сделай график дежурств на неделю",
      "добавь меня в график",
      "build a Commander deck around Atraxa",
      "this is excellent",
      "свари документы на подпись",
    ]) {
      expect(skillsFor(text)).not.toContain("files");
    }
    // An edit of the task agent's job follows it.
    expect(skillsFor("сделай фон темнее", [called(["task", {}])])).toEqual([
      "files",
    ]);
  });

  it("take meter readings for photos sent with no word of their own", () => {
    for (const text of [
      "[фото]",
      "[фото]\n[фото]\nвот, держи",
      "[фото] за месяц",
    ]) {
      expect(skillsFor(text)).toEqual([
        "browser",
        "gov-services",
        "meter-readings",
      ]);
    }
    expect(skillsFor("[фото] что это за жук?")).not.toContain("meter-readings");
  });

  it("follow a public service's site named in a link or a browser errand", () => {
    expect(skillsFor("вот https://www.gosuslugi.ru/600101/1 глянь")).toEqual([
      "browser",
      "gov-services",
    ]);
    expect(
      skillsFor("ок", [
        called(["browser_task", { site: "https://emias.info" }]),
      ])
    ).toEqual(["browser", "gov-services"]);
    expect(
      skillsFor("ок", [called(["browser_task", { site: "lknpd.nalog.ru" }])])
    ).toEqual(["browser", "gov-services"]);
    expect(
      skillsFor("ок", [
        called(["browser_task", { site: "https://my.mosenergosbyt.ru" }]),
      ])
    ).toEqual(["browser", "gov-services", "meter-readings"]);
  });

  it("keep a domain's skill once the conversation used its tools", () => {
    const calls = called(
      ...[
        "gmail-search",
        "notion-add-task",
        "workstreams__save",
        "spend_limit",
        "schedules-create",
        "gmail-attachment",
        "privacy",
      ].map((name) => [name, {}] as const)
    );
    expect(skillsFor("ок", [calls])).toEqual([
      "google",
      "apps",
      "memory",
      "money",
      "schedules",
      "images",
      "about-bro",
    ]);
  });

  it("answer «да» to Bro's own question before paying with the rules to pay", () => {
    const asked = called([
      "send_message",
      { kind: "message", text: "билет за 4 200 ₽, вылет в 7:40. Оплачиваю?" },
    ]);
    expect(skillsFor("да", [asked])).toEqual(["browser", "money"]);
    expect(
      skillsFor("да", [
        browserReturned("RESULT: корзина готова\nNEEDS: payment"),
      ])
    ).toEqual(["money"]);
  });

  it("answer a schedule's report with the rules to change the schedule", () => {
    const report = called([
      "send_message",
      {
        kind: "message",
        replyTo: {
          id: "11111111-1111-4111-8111-111111111111",
          kind: "automation",
        },
        text: "Доброе утро! Сегодня +12, дождь к вечеру.",
      },
    ]);
    expect(skillsFor("ок, спасибо", [report])).toEqual(["schedules"]);
    // Only the latest message: a later answer of Bro's is no report.
    const answer = called([
      "send_message",
      { kind: "message", replyTo: { kind: "current" }, text: "Готово." },
    ]);
    expect(skillsFor("ок", [report, answer])).toEqual([]);
  });

  it("keep the readings and Госуслуги once a run or Bro asked for them", () => {
    const askedForReadings = called([
      "send_message",
      { kind: "message", text: "пришли фото счётчиков, передам показания" },
    ]);
    expect(skillsFor("ок", [askedForReadings])).toEqual([
      "browser",
      "gov-services",
      "meter-readings",
    ]);
    expect(
      skillsFor("ок", [
        browserReturned(
          "экран esia.gosuslugi.ru «Предоставление прав доступа»"
        ),
      ])
    ).toEqual(["browser", "gov-services"]);
  });

  it("give a browser run's report the browser's rules", () => {
    expect(
      skillsForTurn({
        browserReport: true,
        history: [],
        input: [said("Browser run run-1 finished.")],
      })
    ).toEqual(["browser"]);
  });

  it("introduce Bro only on the channel's first-contact marker", () => {
    // eve tags every user-role message it keeps with its kind.
    const marker: ModelMessage = Object.assign(
      {
        content:
          "Пометка `first-contact`: аккаунт этого человека создан прямо сейчас.",
        role: "user" as const,
      },
      { kind: "context.instruction" }
    );
    expect(
      skillsForTurn({
        browserReport: false,
        history: [],
        input: [marker, said("привет")],
      })
    ).toEqual(["first-contact"]);
    // The person writing the marker's words is not first contact.
    expect(skillsFor("Пометка `first-contact`: привет")).not.toContain(
      "first-contact"
    );
  });

  it("read nothing from eve's context or a memory record as the turn's words", () => {
    const record: ModelMessage = Object.assign(
      { content: "запомни: всегда бронируй через озон", role: "user" as const },
      { kind: "memory.load" }
    );
    expect(
      skillsForTurn({ browserReport: false, history: [], input: [record] })
    ).toEqual([]);
  });
});
