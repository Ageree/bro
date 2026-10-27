import type { JSONValue, ModelMessage } from "ai";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

/** eve's durable state, as one session's in-memory store. */
const stores = vi.hoisted(() => new Map<string, unknown>());

vi.mock("eve/context", () => ({
  defineState: <T>(name: string, initial: () => T) => {
    // SAFETY: each name holds only what its own `update` stored, a `T`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one store serves every state's type.
    const read = () => (stores.has(name) ? (stores.get(name) as T) : initial());
    return {
      get: read,
      update: (next: (value: T) => T) => {
        stores.set(name, next(read()));
      },
    };
  },
}));

/** The groups the decision model chooses, and how often it was asked. */
const decisions = vi.hoisted(() => ({ asked: 0, groups: Array.of<string>() }));

vi.mock("@agent/lib/tool-router/system-one", () => ({
  askRouterQuestions: async () => {
    decisions.asked += 1;
    return { groups: decisions.groups };
  },
}));

vi.mock("@agent/lib/tool-router/decision", () => ({
  routerDecision: (answer: { readonly groups: readonly string[] }) => ({
    groups: answer.groups,
    model: "jev-1.14.0",
    ms: 90,
    probabilities: {},
    provider: "typesafe",
  }),
}));

import type { RouterDecision } from "@agent/lib/tool-router/decision";
import { routerGroups } from "@agent/lib/tool-router/questions";
import {
  emptyRouterState,
  readRouterState,
  type RouterState,
} from "@agent/lib/tool-router/state";
import {
  chooseRouterGroups,
  type RouterInputs,
  routerGroupsOfStep,
  routerSkillNote,
  stampRouterUse,
} from "@agent/lib/tool-router/turn";
import { recordTurnStarted } from "@agent/lib/compaction/record";
import { askRouterAhead } from "@agent/lib/tool-router/prefetch";
import { skillRecord } from "@agent/lib/skills/render";

const now = Date.parse("2026-10-15T12:00:00Z");
const minutes = (count: number) => new Date(now - count * 60_000).toISOString();

function inputs(overrides: Partial<RouterInputs> = {}): RouterInputs {
  return {
    compaction: "none",
    digest: "digest-2",
    held: undefined,
    late: undefined,
    located: false,
    mediaOnly: false,
    now,
    opened: [],
    recentMs: 60 * 60_000,
    state: emptyRouterState,
    step: { sessionId: "session-1", stepIndex: 0, turnId: "turn_2" },
    triggered: [],
    voice: false,
    warmMs: 60 * 60_000,
    wholeOnGrowth: false,
    withPrev: true,
    ...overrides,
  };
}

function decided(
  groups: RouterDecision extends infer D
    ? D extends { readonly groups: infer G }
      ? G
      : never
    : never
): RouterDecision {
  return {
    groups,
    model: "jev-1.14.0",
    ms: 90,
    probabilities: {},
    provider: "typesafe",
  };
}

const failed: RouterDecision = { failure: "timeout", ms: 1500 };

/** The state after a decided turn, `ago` minutes ago. */
function after(
  groups: RouterState["carried"],
  ago: number,
  more: Partial<RouterState> = {}
): RouterState {
  return {
    ...emptyRouterState,
    carried: groups,
    lastStepAt: minutes(ago),
    turnDigest: "digest-1",
    turnGroups: groups,
    turnId: "turn_1",
    ...more,
  };
}

describe("the router's choice of a turn's groups", () => {
  it("starts a cold turn from the decision and the turn's own signals", () => {
    const choice = chooseRouterGroups(
      inputs({
        located: true,
        state: { ...emptyRouterState, usedAt: { phone: minutes(10) } },
        triggered: ["schedules"],
      })
    );
    expect(choice.ask).toBe("turn");
    const outcome = choice.finish(decided(["mail"]));
    expect(outcome.groups).toEqual(["places", "phone", "mail", "schedules"]);
    expect(outcome.state.carried).toEqual(outcome.groups);
    expect(outcome.state.turnId).toBe("turn_2");
    expect(outcome.warm).toBe(false);
  });

  it("narrows a skill of several groups to those the decision chose", () => {
    // «Что у меня в календаре в субботу?»: the google skill, Jev — calendar.
    const choice = chooseRouterGroups(inputs({ triggered: ["google"] }));
    expect(choice.finish(decided(["calendar"]))).toMatchObject({
      groups: ["calendar"],
      narrowed: ["mail", "docs"],
    });
    // Jev chose none of the skill's groups: the skill brings all of them.
    const none = chooseRouterGroups(inputs({ triggered: ["google"] }));
    expect(none.finish(decided(["phone"]))).toMatchObject({
      groups: ["phone", "calendar", "mail", "docs"],
      narrowed: [],
    });
    // A group the turn has for another reason stays.
    const recent = chooseRouterGroups(
      inputs({
        state: { ...emptyRouterState, usedAt: { mail: minutes(5) } },
        triggered: ["google", "schedules"],
      })
    ).finish(decided(["calendar"]));
    expect(recent.groups).toEqual(["calendar", "mail", "schedules"]);
    expect(recent.narrowed).toEqual(["docs"]);
  });

  it("keeps every group of the skills without a decision, and of the first contact", () => {
    const pending = chooseRouterGroups(
      inputs({ triggered: ["google"] })
    ).finish(undefined);
    expect(pending.groups).toEqual(["calendar", "mail", "docs"]);
    const failure = chooseRouterGroups(
      inputs({ triggered: ["google"] })
    ).finish(failed);
    expect(failure.groups).toEqual([...routerGroups]);
    const introduced = chooseRouterGroups(
      inputs({ triggered: ["first-contact"] })
    ).finish(decided(["calendar"]));
    expect(introduced.groups).toEqual(["yandex", "phone", "calendar", "mail"]);
    expect(introduced.narrowed).toEqual([]);
  });

  it("narrows the skills of words written mid-turn by their decision", () => {
    const state = after(["phone"], 0, {
      turnDigest: "digest-1",
      turnId: "turn_2",
    });
    const step = { sessionId: "session-1", stepIndex: 1, turnId: "turn_2" };
    const choice = chooseRouterGroups(
      inputs({ state, step, triggered: ["recommendations"] })
    );
    expect(choice.ask).toBe("steer");
    expect(choice.finish(decided(["events"])).groups).toEqual([
      "phone",
      "events",
    ]);
    expect(choice.finish(undefined).groups).toEqual([
      "places",
      "phone",
      "events",
    ]);
  });

  it("gives a turn of the voice every group without asking, and keeps it through its steps", () => {
    // 27.10: each new topic of a voice conversation changed the block, and
    // the step read the whole prompt cold.
    const choice = chooseRouterGroups(
      inputs({
        state: after(["calendar"], 5),
        triggered: ["google"],
        voice: true,
      })
    );
    expect(choice.ask).toBeUndefined();
    const outcome = choice.finish(undefined);
    expect(outcome.groups).toEqual([...routerGroups]);
    expect(outcome.reason).toBe("voice");
    // The person said more mid-turn: nothing to ask, the block stays.
    const next = chooseRouterGroups(
      inputs({
        digest: "digest-3",
        state: outcome.state,
        step: { sessionId: "session-1", stepIndex: 1, turnId: "turn_2" },
        voice: true,
      })
    );
    expect(next.ask).toBeUndefined();
    expect(next.finish(undefined).groups).toEqual([...routerGroups]);
    expect(next.finish(undefined).blockChanged).toBe(false);
  });

  it("keeps the last turn's set within the warm window, and drops it past", () => {
    const warm = chooseRouterGroups(inputs({ state: after(["yandex"], 59) }));
    expect(warm.finish(decided(["mail"])).groups).toEqual(["yandex", "mail"]);
    const cold = chooseRouterGroups(inputs({ state: after(["yandex"], 61) }));
    expect(cold.finish(decided(["mail"])).groups).toEqual(["mail"]);
  });

  it("in the pilot of the whole block, grows a warm set once, to every group", () => {
    const grown = chooseRouterGroups(
      inputs({ state: after(["yandex"], 59), wholeOnGrowth: true })
    ).finish(decided(["mail"]));
    expect(grown.groups).toEqual([...routerGroups]);
    expect(grown.grownWhole).toBe(true);
    expect(grown.state.carried).toEqual([...routerGroups]);
    // A set the block already covers stays as it is.
    const kept = chooseRouterGroups(
      inputs({ state: after(["yandex", "mail"], 30), wholeOnGrowth: true })
    ).finish(decided(["mail"]));
    expect(kept.groups).toEqual(["yandex", "mail"]);
    expect(kept.grownWhole).toBe(false);
    // Past the warm window the set starts afresh, as without the pilot.
    const cold = chooseRouterGroups(
      inputs({ state: after(["yandex"], 61), wholeOnGrowth: true })
    ).finish(decided(["mail"]));
    expect(cold.groups).toEqual(["mail"]);
    // A group `open_tools` opens mid-turn grows the turn's block whole too.
    const step = { sessionId: "session-1", stepIndex: 1, turnId: "turn_2" };
    const opened = chooseRouterGroups(
      inputs({
        digest: "digest-1",
        opened: ["phone"],
        state: after(["yandex"], 0, { turnId: "turn_2" }),
        step,
        wholeOnGrowth: true,
      })
    ).finish(undefined);
    expect(opened.groups).toEqual([...routerGroups]);
  });

  it("forgets a group used longer ago than the recent window", () => {
    const state = {
      ...emptyRouterState,
      usedAt: { calendar: minutes(59), phone: minutes(61) },
    };
    const outcome = chooseRouterGroups(inputs({ state })).finish(decided([]));
    expect(outcome.groups).toEqual(["calendar"]);
  });

  it("opens every group on a failure, and keeps the base for the next turn", () => {
    const outcome = chooseRouterGroups(
      inputs({ state: after(["yandex"], 5) })
    ).finish(failed);
    expect(outcome.groups).toEqual([...routerGroups]);
    expect(outcome.state.failedOpen).toBe(true);
    expect(outcome.state.carried).toEqual(["yandex"]);

    const next = chooseRouterGroups(
      inputs({
        digest: "digest-3",
        state: outcome.state,
        step: { sessionId: "session-1", stepIndex: 0, turnId: "turn_3" },
      })
    ).finish(decided(["phone"]));
    expect(next.groups).toEqual(["yandex", "phone"]);
  });

  it("keeps the set of a turn with the same words without asking", () => {
    // An approval's answer is a new turn without a new message.
    const choice = chooseRouterGroups(
      inputs({ digest: "digest-1", state: after(["phone"], 2) })
    );
    expect(choice.ask).toBeUndefined();
    expect(choice.finish(undefined)).toMatchObject({
      groups: ["phone"],
      reason: "reused",
    });
    // So does a first step run again, and after a failure too.
    const again = chooseRouterGroups(
      inputs({
        digest: "digest-1",
        state: after([...routerGroups], 0, {
          failedOpen: true,
          turnId: "turn_2",
        }),
      })
    );
    expect(again.ask).toBeUndefined();
    expect(again.finish(undefined).groups).toEqual([...routerGroups]);
  });

  it("grows a later step by what was opened, and never shrinks it", () => {
    const state = after(["phone"], 0, {
      turnDigest: "digest-2",
      turnId: "turn_2",
    });
    const step = { sessionId: "session-1", stepIndex: 2, turnId: "turn_2" };
    const choice = chooseRouterGroups(
      inputs({ opened: ["media"], state, step, triggered: ["money"] })
    );
    expect(choice.ask).toBeUndefined();
    expect(choice.finish(undefined).groups).toEqual(["phone", "media"]);
  });

  it("adds the words written mid-turn, unless the turn was compacted", () => {
    const state = after(["phone"], 0, {
      turnDigest: "digest-1",
      turnId: "turn_2",
    });
    const step = { sessionId: "session-1", stepIndex: 1, turnId: "turn_2" };
    const steer = chooseRouterGroups(
      inputs({ state, step, triggered: ["schedules"] })
    );
    expect(steer.ask).toBe("steer");
    expect(steer.finish(decided(["mail"])).groups).toEqual([
      "phone",
      "mail",
      "schedules",
    ]);
    const compacted = chooseRouterGroups(
      inputs({ compaction: "start", state, step, triggered: ["schedules"] })
    );
    expect(compacted.ask).toBeUndefined();
    expect(compacted.finish(undefined).groups).toEqual(["phone"]);
  });

  it("takes a decision that came after its step at the next one", () => {
    const state = after(["phone"], 0, {
      turnDigest: "digest-2",
      turnId: "turn_2",
    });
    const step = { sessionId: "session-1", stepIndex: 1, turnId: "turn_2" };
    const outcome = chooseRouterGroups(
      inputs({
        late: { kind: "turn", settled: decided(["events"]) },
        state,
        step,
      })
    ).finish(undefined);
    expect(outcome.groups).toEqual(["phone", "events"]);
    expect(outcome.state.carried).toEqual(["phone", "events"]);
  });

  it("does not read the words of a turn compacted inside", () => {
    const outcome = chooseRouterGroups(
      inputs({ compaction: "inside", state: after(["yandex"], 90) })
    );
    expect(outcome.ask).toBeUndefined();
    expect(outcome.finish(undefined)).toMatchObject({
      groups: ["yandex"],
      reason: "unreadable",
    });
    const blind = chooseRouterGroups(inputs({ compaction: "inside" }));
    expect(blind.finish(undefined).groups).toEqual([...routerGroups]);
  });

  it("asks nothing when the signals already cover every group", () => {
    const choice = chooseRouterGroups(
      inputs({ state: after([...routerGroups], 3) })
    );
    expect(choice.ask).toBeUndefined();
    expect(choice.finish(undefined).reason).toBe("covered");
  });

  it("opens every group for a bare photo with nothing before it, and files with", () => {
    const blind = chooseRouterGroups(
      inputs({ mediaOnly: true, withPrev: false })
    );
    expect(blind.ask).toBeUndefined();
    expect(blind.finish(undefined).groups).toEqual([...routerGroups]);
    const read = chooseRouterGroups(inputs({ mediaOnly: true }));
    expect(read.ask).toBe("turn");
    expect(read.finish(decided(["browser"])).groups).toEqual([
      "browser",
      "files",
    ]);
  });
});

function assistant(
  ...calls: readonly (readonly [string, Record<string, string>])[]
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

const person = (text: string): ModelMessage =>
  Object.assign({ content: text, role: "user" as const }, { kind: "user" });

describe("what a step tells the router", () => {
  beforeEach(() => {
    stores.clear();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks the groups of the tools called, but not of the shared ones", () => {
    stampRouterUse(
      [
        person("позвони маме и найди письмо"),
        assistant(["phone-call", {}], ["contacts-search", {}], ["apps", {}]),
      ],
      { sessionId: "session-1", stepIndex: 1, turnId: "turn_1" },
      "shadow"
    );
    expect(Object.keys(readRouterState().usedAt)).toEqual(["phone"]);
  });

  it("marks the browser's group after an errand, though browser_task is core", () => {
    stampRouterUse(
      [
        person("купи билеты"),
        assistant(["browser_task", { action: "continue" }]),
      ],
      { sessionId: "session-1", stepIndex: 1, turnId: "turn_1" },
      "shadow"
    );
    expect(Object.keys(readRouterState().usedAt)).toEqual(["browser"]);
  });

  it("logs a call outside the turn's set, and the turn's result after it", () => {
    stores.set("bro.tool-router", after(["mail"], 0, { called: [] }));
    const info = vi.mocked(console.info);
    stampRouterUse(
      [person("позвони маме"), assistant(["phone-call", {}])],
      { sessionId: "session-1", stepIndex: 1, turnId: "turn_1" },
      "on"
    );
    expect(info).toHaveBeenCalledWith("[tool-router] hidden-call", {
      groups: ["phone"],
      tool: "phone-call",
      turnId: "turn_1",
    });
    expect(readRouterState().called).toEqual(["phone"]);

    stampRouterUse(
      [person("позвони маме"), assistant(["phone-call", {}]), person("ну?")],
      { sessionId: "session-1", stepIndex: 0, turnId: "turn_2" },
      "on"
    );
    expect(info).toHaveBeenCalledWith("[tool-router] result", {
      called: ["phone"],
      groups: ["mail"],
      missed: ["phone"],
      turnId: "turn_1",
    });
    expect(readRouterState().called).toBeNull();
  });

  it("logs Bro saying it cannot in a turn it narrowed", () => {
    stores.set("bro.tool-router", after(["mail"], 0, { called: [] }));
    stampRouterUse(
      [
        person("нарисуй кота"),
        assistant(["send_message", { text: "Не могу рисовать." }]),
      ],
      { sessionId: "session-1", stepIndex: 1, turnId: "turn_1" },
      "on"
    );
    expect(console.info).toHaveBeenCalledWith("[tool-router] cannot", {
      groups: ["mail"],
      turnId: "turn_1",
    });
  });
});

describe("the note of a group without its rules", () => {
  const setup = { browser: true, images: true };

  it("asks to load the skill of an open group whose block is missing", () => {
    expect(
      routerSkillNote(
        ["phone", "calendar", "mail"],
        [person("ответь Лене")],
        setup
      )
    ).toBe(
      "Инструменты групп calendar, mail открыты без своих правил: перед первым вызовом — load_skill google."
    );
    // The tools of places are core: a reminder at a place needs no skill.
    expect(
      routerSkillNote(
        ["places"],
        [person("напомни купить хлеб, когда приду на Тверскую 7")],
        setup
      )
    ).toBeUndefined();
  });

  it("says nothing once the block is in the conversation", () => {
    const block = Object.assign(
      { content: skillRecord("google", setup) ?? "", role: "user" as const },
      { kind: "memory.load" }
    );
    expect(
      routerSkillNote(["mail"], [person("ответь Лене"), block], setup)
    ).toBeUndefined();
  });
});

/** A tool's call and its result, as one step leaves them. */
function called(
  id: string,
  toolName: string,
  input: JSONValue,
  output: JSONValue
): ModelMessage[] {
  return [
    {
      content: [{ input, toolCallId: id, toolName, type: "tool-call" }],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "json", value: output },
          toolCallId: id,
          toolName,
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
}

describe("a person's step in the router's pilot", () => {
  const setup = { browser: true, images: true };

  beforeEach(() => {
    stores.clear();
    decisions.asked = 0;
    decisions.groups = [];
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a group open_tools opened when the person writes again before the next step", async () => {
    decisions.groups = ["mail"];
    const opener = person("напиши Лене");
    await routerGroupsOfStep(
      [opener],
      { sessionId: "session-1", stepIndex: 0, turnId: "turn_1" },
      setup,
      "on"
    );
    const groups = await routerGroupsOfStep(
      [
        opener,
        ...called(
          "call-1",
          "open_tools",
          { groups: ["phone"] },
          { opened: ["phone"] }
        ),
        person("или лучше позвони ей"),
      ],
      { sessionId: "session-1", stepIndex: 1, turnId: "turn_1" },
      setup,
      "on"
    );
    expect(groups).toContain("phone");
    expect(groups).toContain("mail");
  });

  it("asks again after the person answered Bro's question mid-turn", async () => {
    decisions.groups = ["mail"];
    const opener = person("свяжись с Леной");
    const step = { sessionId: "session-1", turnId: "turn_1" };
    // eve's compaction did nothing to the turn.
    recordTurnStarted("turn_1");
    await routerGroupsOfStep([opener], { ...step, stepIndex: 0 }, setup, "on");
    expect(decisions.asked).toBe(1);
    decisions.groups = ["phone"];
    const groups = await routerGroupsOfStep(
      [
        opener,
        ...called(
          "call-1",
          "ask_question",
          {
            options: [
              { id: "mail", label: "Написать письмо" },
              { id: "call", label: "Позвонить" },
            ],
            prompt: "Написать Лене письмо или позвонить?",
          },
          { optionId: "call", status: "answered" }
        ),
      ],
      { ...step, stepIndex: 1 },
      setup,
      "on"
    );
    expect(decisions.asked).toBe(2);
    expect(groups).toEqual(expect.arrayContaining(["mail", "phone"]));
  });

  it("gives a calendar question the calendar alone, and a place-bound reminder places", async () => {
    decisions.groups = ["calendar"];
    const info = vi.mocked(console.info);
    const calendar = await routerGroupsOfStep(
      [person("Что у меня в календаре в субботу?")],
      { sessionId: "session-1", stepIndex: 0, turnId: "turn_1" },
      setup,
      "on"
    );
    expect(calendar).toEqual(["calendar"]);
    expect(info).toHaveBeenCalledWith(
      "[tool-router]",
      expect.objectContaining({ narrowed: ["mail", "docs"] })
    );
    decisions.groups = [];
    const reminder = await routerGroupsOfStep(
      [
        person(
          "Напомни мне купить хлеб, когда я приду на Тверскую улицу 7 в Москве"
        ),
      ],
      { sessionId: "session-2", stepIndex: 0 },
      setup,
      "on"
    );
    expect(reminder).toContain("places");
    // Sharing or following their location is about their place too (19.10).
    const following = await routerGroupsOfStep(
      [
        person(
          "И ты типо можешь в реальном времени смотреть за моим местом положения?"
        ),
      ],
      { sessionId: "session-4", stepIndex: 0 },
      setup,
      "on"
    );
    expect(following).toContain("places");
  });

  it("keeps the whole set in shadow, and logs what on would have narrowed", async () => {
    decisions.groups = ["calendar"];
    const info = vi.mocked(console.info);
    const groups = await routerGroupsOfStep(
      [person("Что у меня в календаре в субботу?")],
      { sessionId: "session-3", stepIndex: 0, turnId: "turn_1" },
      setup,
      "shadow"
    );
    expect(groups).toEqual(expect.arrayContaining(["mail", "docs"]));
    await vi.waitFor(() => {
      expect(info).toHaveBeenCalledWith(
        "[tool-router] shadow-decision",
        expect.objectContaining({
          decided: ["calendar"],
          narrowed: ["mail", "docs"],
        })
      );
    });
  });

  it("takes the decision a channel asked before the turn started", async () => {
    decisions.groups = ["calendar"];
    askRouterAhead({
      previous: "Готово, записал.",
      words: "что у меня завтра?",
    });
    expect(decisions.asked).toBe(1);
    const groups = await routerGroupsOfStep(
      [
        person("запиши к врачу"),
        assistant(["send_message", { text: "Готово, записал." }]),
        person("что у меня завтра?"),
      ],
      { sessionId: "session-1", stepIndex: 0, turnId: "turn_3" },
      setup,
      "on"
    );
    expect(decisions.asked).toBe(1);
    expect(groups).toContain("calendar");
  });

  it("asks ahead only for a workspace whose step asks the router", async () => {
    // The environment is read once, when its module loads.
    const askedAhead = async (pilots: Readonly<Record<string, string>>) => {
      for (const [name, value] of Object.entries(pilots)) {
        vi.stubEnv(name, value);
      }
      vi.resetModules();
      const prefetch = await import("@agent/lib/tool-router/prefetch");
      prefetch.noteBroMessage("chat-ahead", [
        { input: { text: "Записал на пятницу." }, toolName: "send_message" },
      ]);
      const asked = decisions.asked;
      prefetch.askRouterAboutNext({
        conversation: "chat-ahead",
        words: "а что в субботу?",
        workspaceId: "workspace-1",
      });
      return decisions.asked > asked;
    };
    const everyone = {
      MODEL_PROVIDER: "routerai",
      ROUTERAI_API_KEY: "routerai-test-key",
      SKILLS_WORKSPACES: "*",
      STEP_CONTEXT_WORKSPACES: "*",
      TOOL_ROUTER_WORKSPACES: "*",
    };
    onTestFinished(() => {
      // tests/setup-env.ts leaves them unset; `vi.unstubAllEnvs()` would
      // drop its stubs too.
      for (const name of Object.keys(everyone)) vi.stubEnv(name, "");
      vi.resetModules();
    });
    expect(await askedAhead(everyone)).toBe(true);
    expect(
      await askedAhead({ ...everyone, SKILLS_WORKSPACES: "workspace-owner" })
    ).toBe(false);
    expect(
      await askedAhead({
        ...everyone,
        STEP_CONTEXT_WORKSPACES: "owner@example.com",
      })
    ).toBe(false);
  });

  it("asks at the step when the channel asked about other words", async () => {
    askRouterAhead({ previous: "Готово, записал.", words: "спасибо" });
    await routerGroupsOfStep(
      [
        person("запиши к врачу"),
        assistant(["send_message", { text: "Готово." }]),
        person("спасибо"),
      ],
      { sessionId: "session-1", stepIndex: 0, turnId: "turn_4" },
      setup,
      "on"
    );
    expect(decisions.asked).toBe(2);
  });

  it("offers the first contact's call and Yandex in the turns after it", async () => {
    const marker = Object.assign(
      {
        content: "Это первое сообщение воркспейса: `first-contact`.",
        role: "user" as const,
      },
      { kind: "context.first-contact" }
    );
    const groups = await routerGroupsOfStep(
      [
        marker,
        person("Привет"),
        assistant(["send_message", { text: "Привет! Расскажи о себе." }]),
        person("Я Аня, дизайнер из Казани"),
      ],
      { sessionId: "session-1", stepIndex: 0, turnId: "turn_2" },
      setup,
      "on"
    );
    expect(groups).toEqual(
      expect.arrayContaining(["calendar", "mail", "phone", "yandex"])
    );
  });
});
