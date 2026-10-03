import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { SkillName } from "@agent/lib/skills/catalog";

// Which tools a step has is a pure function of its messages: it reads no
// database.
vi.mock("@db", () => {
  throw new Error("Tool groups must not reach the database.");
});

const [
  { skillRecord, skillStub },
  {
    groupsOfTool,
    groupedToolNames,
    offeredSkills,
    toolGroup,
    toolOffered,
    turnOfferedSkills,
  },
  { skillsForTurn },
] = await Promise.all([
  import("@agent/lib/skills/render"),
  import("@agent/lib/skills/tools"),
  import("@agent/lib/skills/triggers"),
]);

const setup = { browser: true, images: true };

function person(text: string): ModelMessage {
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

/** A record of the `skills` slot, as eve keeps it in history. */
function record(name: SkillName, content = skillRecord(name, setup) ?? "") {
  return Object.assign(
    { content, role: "user" as const },
    { kind: "memory.load" }
  );
}

function firstContactMarker(): ModelMessage {
  return Object.assign(
    {
      content: "Это первое сообщение воркспейса: `first-contact`.",
      role: "user" as const,
    },
    { kind: "context.first-contact" }
  );
}

function called(
  toolName: string,
  input: Readonly<Record<string, string>> = {}
): ModelMessage {
  return {
    content: [{ input, toolCallId: "call-1", toolName, type: "tool-call" }],
    role: "assistant",
  };
}

function loaded(name: SkillName): ModelMessage {
  return {
    content: [
      {
        output: { type: "text", value: skillRecord(name, setup) ?? "" },
        toolCallId: "call-2",
        toolName: "load_skill",
        type: "tool-result",
      },
    ],
    role: "tool",
  };
}

const offered = (messages: readonly ModelMessage[]) =>
  offeredSkills(messages, setup);

/** The gated tools a step of these skills has. */
const gatedTools = (skills: readonly SkillName[]) =>
  groupedToolNames.filter(
    (name) => toolGroup(name) !== undefined && toolOffered(name, skills)
  );

describe("the tools that follow skills", () => {
  it("keep the core tools in every step, and an unknown tool too", () => {
    for (const name of [
      "send_message",
      "ask_question",
      "browser_task",
      "list_orders",
      "calendar-list-events",
      "schedules-list",
      "schedules-answer",
      "profile__forget_all",
      "load_skill",
      "a-tool-from-tomorrow",
    ]) {
      expect(toolOffered(name, [])).toBe(true);
    }
  });

  it("offer a domain's tools with its skill", () => {
    expect(gatedTools([])).toEqual([]);
    expect(gatedTools(["money"])).toEqual([
      "spend_limit",
      "standing_permission",
    ]);
    expect(gatedTools(["schedules"])).toEqual([
      "schedules-create",
      "schedules-update",
      "watch-create",
    ]);
    expect(gatedTools(["apps"])).toContain("notion-add-task");
    expect(gatedTools(["google"])).toEqual(gatedTools(["first-contact"]));
    expect(gatedTools(["google"])).toEqual(
      expect.arrayContaining(["gmail-send", "connect_google", "drive-read"])
    );
    expect(gatedTools(["google"])).not.toContain("calendar-list-events");
  });

  it("keep a domain's skill for the turns after its tool was used", () => {
    // `skillsForTurn` keeps a skill once its tool was called: so a group,
    // once used, stays offered.
    for (const name of groupedToolNames) {
      const groups = groupsOfTool(name);
      if (groups.length === 0) continue;
      const kept = skillsForTurn({
        browserReport: false,
        history: [called(name)],
        input: [person("ок")],
      });
      expect([name, kept.some((skill) => groups.includes(skill))]).toEqual([
        name,
        true,
      ]);
    }
  });

  it("offer what the turn's words need, from its first step", () => {
    expect(offered([person("Ответь Лене на письмо про отпуск")])).toEqual(
      expect.arrayContaining(["google"])
    );
    expect(offered([person("Что у меня завтра?")])).toEqual(["google"]);
    expect(offered([person("Привет! Как дела?")])).toEqual([]);
    expect(offered([person("Больше не присылай сводку")])).toEqual([
      "schedules",
    ]);
    expect(
      offered([person("Спрашивай меня снова, прежде чем записывать")])
    ).toEqual(["money"]);
  });

  it("offer google on a workspace's first message", () => {
    expect(offered([firstContactMarker(), person("Привет")])).toEqual([
      "first-contact",
    ]);
    expect(
      gatedTools(offered([firstContactMarker(), person("Привет")]))
    ).toContain("connect_google");
  });

  it("keep a group for the rest of the session once its block came", () => {
    const first = [
      person("Напомни завтра в 9 позвонить маме"),
      record("schedules"),
    ];
    const later = [...first, person("Спасибо!")];
    expect(offered(first)).toEqual(["schedules"]);
    // The next turn says nothing of schedules, and the tools stay.
    expect(offered(later)).toEqual(["schedules"]);
  });

  it("count a stale block, but not a stub", () => {
    expect(
      offered([
        record("money", '<bro-skill name="money">\nold rules\n</bro-skill>'),
        person("Спасибо!"),
      ])
    ).toEqual(["money"]);
    expect(
      offered([record("money", skillStub("money")), person("Спасибо!")])
    ).toEqual([]);
  });

  it("add a group from the step after load_skill, and keep it", () => {
    const opening = [person("Позвони Ане")];
    expect(offered(opening)).toEqual([]);
    const afterLoad = [
      ...opening,
      called("load_skill", { name: "google" }),
      loaded("google"),
    ];
    expect(offered(afterLoad)).toEqual(["google"]);
    expect(offered([...afterLoad, person("Ок")])).toEqual(["google"]);
  });

  it("stay the same through a turn, whatever Bro sent in it", () => {
    const opening = [person("Купи билет в Казань на пятницу")];
    const steps = [
      opening,
      [
        ...opening,
        called("send_message", {
          kind: "message",
          text: "Нашёл за 4 500 ₽. Оплачиваю?",
        }),
      ],
    ];
    // Bro's own question before paying keeps money for the person's «да»,
    // in the turn after it, not mid-turn.
    expect(new Set(steps.map((messages) => offered(messages).join()))).toEqual(
      new Set([offered(opening).join()])
    );
    expect(offered([...(steps[1] ?? []), person("да")])).toContain("money");
  });
});

/** A step of a turn in the session of these tests. */
function step(stepIndex: number, turnId = "turn_4") {
  return { sessionId: "wrun_skills", stepIndex, turnId };
}

describe("the skills of a turn in the pilot of compaction", () => {
  // eve's compaction at the turn's first step, after its tools were chosen:
  // the summary takes the `load_skill` result away.
  const summary: ModelMessage[] = [
    Object.assign(
      { content: "Summary of our conversation so far:", role: "user" as const },
      { kind: "context.compaction" }
    ),
    { content: "Человек читал почту.", role: "assistant" },
  ];
  const opener = person("ну и?");
  const history = [person("что в почте?"), loaded("google"), opener];

  it("keep a group the summary took away to the turn's end", () => {
    expect(offered(history)).toEqual(["google"]);
    expect(offered([...summary, opener])).toEqual([]);

    expect(turnOfferedSkills(history, setup, step(0))).toEqual(["google"]);
    expect(
      turnOfferedSkills(
        [...summary, opener, called("gmail-search")],
        setup,
        step(1)
      )
    ).toEqual(["google"]);
    // The next turn reads the compacted conversation as it is.
    expect(
      turnOfferedSkills(
        [...summary, person("спасибо")],
        setup,
        step(0, "turn_5")
      )
    ).toEqual([]);
    // Without a turn id, the step's own.
    expect(
      turnOfferedSkills([...summary, opener], setup, {
        sessionId: "wrun_skills",
      })
    ).toEqual([]);
  });
});

describe("a skill's body", () => {
  it("names another group's tool only with the way to get it", async () => {
    const { availableSkills, skillBody } =
      await import("@agent/lib/skills/catalog");
    const unreachable = availableSkills(setup).flatMap((skill) => {
      const body = skillBody(skill, setup) ?? "";
      return groupedToolNames.flatMap((name) => {
        const group = toolGroup(name);
        if (group === undefined || !body.includes(`\`${name}\``)) return [];
        if (toolOffered(name, [skill])) return [];
        return body.includes(`load_skill ${group}`) ? [] : [[skill, name]];
      });
    });
    expect(unreachable).toEqual([]);
  });

  it("offers the mail and Drive searches of the Госуслуги fallback", () => {
    expect(toolOffered("gmail-search", ["gov-services"])).toBe(true);
    expect(toolOffered("drive-search", ["gov-services"])).toBe(true);
    expect(toolOffered("gmail-send", ["gov-services"])).toBe(false);
  });
});
