import { describe, expect, it } from "vitest";
import {
  fullDeployment,
  stubDeployment,
  taskAgentDeployment,
} from "@tests/helpers/system-prompt";
import {
  type CatalogTool,
  catalogContext,
  type catalogKinds,
  toolCatalog,
} from "@tests/helpers/tool-catalog";

/**
 * The tools of the skills pilot (docs/roadmap.md, item 25): which group
 * each tool is in, and the short descriptions a turn of the pilot reads.
 * What a short description leaves out is in the skill's body, which comes
 * with the tool, or in the tool's refusals and results.
 */

const setup = { browser: true, images: true };

/** The tools that read short in the pilot, and the most each may take. */
const shortened = {
  browser_task: 1_950,
  connect_google: 400,
  "gmail-send": 700,
  route_time: 450,
  "schedules-create": 1_850,
  "schedules-update": 1_800,
  standing_permission: 650,
} as const;

/** Tokens as `scripts/costs/step-context.ts` estimates a tool's JSON. */
const tokens = (tool: CatalogTool) =>
  Math.round(
    JSON.stringify({
      function: {
        description: tool.description,
        name: tool.name,
        parameters: tool.inputSchema,
      },
      type: "function",
    }).length / 3.7
  );

async function catalog(
  kind: keyof typeof catalogKinds,
  pilot: boolean,
  environment: Record<string, string> = fullDeployment
) {
  const deployment = { ...environment };
  if (pilot) deployment.SKILLS_WORKSPACES = "workspace-1";
  stubDeployment(deployment);
  return new Map(
    (
      await toolCatalog(
        catalogContext(kind, [
          { content: "Нарисуй кота", role: "user" as const },
        ])
      )
    ).map((tool) => [tool.name, tool])
  );
}

/** A tool's JSON Schema without its words: what a call may carry. */
function parameters(tool: CatalogTool | undefined) {
  return JSON.stringify(tool?.inputSchema ?? {}).replaceAll(
    /"description":"(?:[^"\\]|\\.)*",?/gu,
    ""
  );
}

describe("the tools of the skills pilot", () => {
  it("are each in the table of groups", { timeout: 60_000 }, async () => {
    const { groupedToolNames } = await import("@agent/lib/skills/tools");
    const names = new Set([
      ...(
        await catalog("web", true, {
          ...fullDeployment,
          ...taskAgentDeployment,
        })
      ).keys(),
      ...(await catalog("web", false)).keys(),
      ...(await catalog("telegram", true)).keys(),
    ]);
    expect(names.size).toBeGreaterThan(55);
    expect(
      [...names].filter((name) => !groupedToolNames.includes(name))
    ).toEqual([]);
  });

  it(
    "read short only in a turn of the pilot, with the same parameters",
    { timeout: 60_000 },
    async () => {
      const [full, short, worker] = [
        await catalog("web", false),
        await catalog("web", true),
        await catalog("scheduled-worker", true),
      ];
      for (const name of Object.keys(shortened)) {
        const before = full.get(name);
        const after = short.get(name);
        expect([name, after?.description]).not.toEqual([
          name,
          before?.description,
        ]);
        expect(parameters(after)).toBe(parameters(before));
      }
      expect(short.get("browser_task")?.description).toContain(
        "call load_skill browser"
      );
      // A worker reads the full instructions, and the full tools.
      expect(
        Object.keys(shortened).flatMap((name) => {
          const own = worker.get(name);
          return own === undefined ||
            own.description === full.get(name)?.description
            ? []
            : [name];
        })
      ).toEqual([]);
    }
  );

  it("take about half of what they took", { timeout: 60_000 }, async () => {
    const [full, short] = [
      await catalog("web", false),
      await catalog("web", true),
    ];
    const sizes = Object.fromEntries(
      Object.keys(shortened).map((name) => {
        const tool = short.get(name);
        return [name, tool === undefined ? 0 : tokens(tool)];
      })
    );
    for (const [name, most] of Object.entries(shortened)) {
      expect([name, sizes[name] ?? 0]).toEqual([
        name,
        Math.min(sizes[name] ?? 0, most),
      ]);
    }
    const sum = (tools: Map<string, CatalogTool>) =>
      Object.keys(shortened).reduce((total, name) => {
        const tool = tools.get(name);
        return total + (tool === undefined ? 0 : tokens(tool));
      }, 0);
    expect(sum(short)).toBeLessThan(sum(full) * 0.55);
  });
});

/**
 * What a short description left out, by where it is said now: a skill's
 * body, which the tool comes with (`agent/lib/skills/tools.ts`), or the
 * text of a browser report's turn, which attaches no schedules body.
 */
const carried = {
  browser: [
    ["one run per errand", "ровно один запуск"],
    ["a round trip is one errand", "Поездка туда и обратно — одно поручение"],
    ["a delivery time the user named", "«к восьми вечера»"],
    ["the run's own country", "убедись, что сайт работает там, где человек"],
    ["fallback sites", "два-три запасных сайта"],
    ["queued", '`status: "queued"`'],
    ["out of credits", '`status: "unavailable"`'],
    ["a new runId", "возвращает **новый** `runId`"],
    ["no password", "Никогда не проси у человека пароль."],
    ["the code from mail", '`codeFrom: "mail"`'],
    ["the phone's secret", "работает только на домене `site` этого поручения"],
    ["CAPTCHAs", "Человек капчу не решает никогда"],
    ["anti-bot retries", "до пяти попыток примерно за полчаса"],
    ["the live view", "Ссылку на живой просмотр шли только тогда"],
    ["pictures", "`collectImages: true`"],
    ["delivery address", "`deliveryAddress: true`"],
    [
      "status, not continue",
      "спрашивать у запуска, как дела, через `continue` нельзя",
    ],
    ["partial results", "пятнадцать минут"],
    ["the payment question", "Оплата — единственный вопрос."],
    ["a confirmed errand", "Согласие принадлежит поручению."],
    ["a found option first", "`submission` называет один конкретный вариант"],
    ["standing permissions", "по постоянному разрешению"],
    ["binding a card", "`allowPayment: true` нужен для «привяжи карту»"],
  ],
  recommendations: [
    ["credit the map", "по данным © OpenStreetMap"],
    ["no made-up minutes", "минуты не выдумывай"],
    ["each option its own row", "у каждого варианта — минуты его строки"],
    ["an uncertain place", "Результат с `uncertain` фактом не выдавай"],
  ],
  google: [
    ["the link and its ten minutes", "она живёт 10 минут"],
    ["not configured", "`not_configured` — скажи прямо"],
    ["no question before sending", "не спрашивай «отправить?» текстом"],
    ["a declined card", "сохрани то же письмо через `gmail-draft`"],
    ["the person's voice", "`yourEarlierEmails`"],
  ],
  money: [
    ["a sensible ceiling", "поставь разумный сам"],
    ["revoke", '`standing_permission` с `action: "revoke"`'],
    ["nothing to revoke", "`revoke` не вызывай"],
    [
      "only in the person's turn",
      "Разрешение действует только в ходе, который начал сам человек",
    ],
  ],
  schedules: [
    ["a reminder is once", '`kind: "once"` с `at` по часам человека'],
    ["a calendar rule", "«каждое второе воскресенье» — `monthly_weekday`"],
    [
      "interval for minutes or hours",
      "`interval` — только для счёта минут или часов",
    ],
    ["the zone from the profile", "`timezone` не ставь"],
    ["holidays", "`skipHolidays: true` — только когда человек попросил"],
    [
      "every input of a run",
      "запуск этот разговор не видит и переспрашивать не должен",
    ],
    ["missing inputs", "`missingInputs`"],
    ["the first run", "назови ровно `nextRunLocal`"],
    ["a trial run", "`runNow: true`"],
    ["a run never acts", "только проверяет, ищет и готовит до последнего шага"],
    ["nothing made up", "не добавляй условий, которых он не называл"],
  ],
} satisfies Readonly<Record<string, readonly (readonly [string, string])[]>>;

describe("what the short descriptions left out", () => {
  it.each(Object.entries(carried))(
    "is in the body of %s",
    async (skill, rules) => {
      const { skillBody, skillNames } =
        await import("@agent/lib/skills/catalog");
      const name = skillNames.find((known) => known === skill);
      const body = name === undefined ? "" : (skillBody(name, setup) ?? "");
      expect(
        rules.flatMap(([rule, phrase]) => (body.includes(phrase) ? [] : [rule]))
      ).toEqual([]);
    }
  );

  it("is said to a browser report's turn, which attaches no schedules body", async () => {
    const { calendarInstruction, laterStepInstruction } =
      await import("@agent/lib/browser-use/guidance");
    expect(laterStepInstruction).toContain(
      "Then set it up with schedules-create for the moment it opens"
    );
    expect(laterStepInstruction).toContain(
      "never copy links, instructions or any other text"
    );
    expect(laterStepInstruction).toContain(
      "A scheduled run only checks and stages the step"
    );
    expect(calendarInstruction).toContain("Then call calendar-create-event");
  });
});
