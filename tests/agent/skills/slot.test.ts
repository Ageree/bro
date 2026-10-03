import { readdirSync } from "node:fs";
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Marked files, so that skills exist: games for every deployment, the
// browser's only where a browser is set up.
vi.mock("@agent/instructions/content/creative/games.md?raw", () => ({
  default:
    "# Игры\n<!-- skill:games -->\n- Правило игры.\n<!-- /skill -->\n- Общее.\n",
}));
vi.mock("@agent/instructions/content/browser/available.md?raw", () => ({
  default:
    "# Браузер\n- Ядро браузера.\n<!-- skill:browser -->\n- Правило поручения.\n<!-- /skill -->\n",
}));
// The slot and the tool read nothing from the database.
vi.mock("@db", () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error("Skills must not reach the database.");
      },
    }
  ),
}));

const workspaceId = "workspace-1";

/** Every variable a case sets; `tests/setup-env.ts` unsets them all. */
const variables = [
  "BROWSER_USE_API_KEY",
  "OPENROUTER_API_KEY",
  "SKILLS_WORKSPACES",
] as const;

async function load(
  environment: Partial<Record<(typeof variables)[number], string>> = {
    BROWSER_USE_API_KEY: "test-browser-use-key",
    OPENROUTER_API_KEY: "test-openrouter-key",
    SKILLS_WORKSPACES: workspaceId,
  }
) {
  for (const name of variables) vi.stubEnv(name, environment[name]);
  // The environment is read once, when its module loads.
  vi.resetModules();
  const [slot, tool, render, said, language] = await Promise.all([
    import("@agent/memory/bro_skills"),
    import("@agent/tools/load_skill"),
    import("@agent/lib/skills/render"),
    import("@agent/lib/browser-use/said"),
    import("@agent/lib/delivery/language"),
  ]);
  return {
    language: language.personLanguage,
    loadSkill: tool.default,
    personWordsThisTurn: said.personWordsThisTurn,
    skillGone: render.skillGone,
    skillRecord: render.skillRecord,
    skillStub: render.skillStub,
    skills: slot.default,
  };
}

afterEach(() => {
  for (const name of variables) vi.stubEnv(name, undefined);
  vi.restoreAllMocks();
});

function person(text: string): ModelMessage {
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

/** A record of the slot as eve keeps it in history. */
function record(content: string): ModelMessage {
  return Object.assign(
    { content, role: "user" as const },
    { kind: "memory.load" }
  );
}

function callerOf(
  authenticator: string,
  attributes: Record<string, string> = {}
) {
  return {
    attributes: { ...attributes, workspaceId },
    authenticator,
    principalId: "user-1",
    principalType: "user" as const,
  };
}

function turnContext(
  options: {
    readonly authenticator?: string;
    readonly attributes?: Record<string, string>;
    readonly history?: readonly ModelMessage[];
    readonly initiator?: ReturnType<typeof callerOf> | null;
    readonly input?: readonly ModelMessage[];
  } = {}
) {
  return {
    abortSignal: new AbortController().signal,
    channel: { kind: "channel:eve", metadata: {} },
    getSandbox() {
      throw new Error("Sandbox access is outside this test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this test.");
    },
    getToken() {
      throw new Error("Token access is outside this test.");
    },
    memory: {
      scope: { key: "skills-key", namespace: "bro-skills-v1", value: "skills" },
      slot: "skills",
    },
    messages: [...(options.history ?? [])],
    model: null,
    operationId: "session-1:1:turn.started:skills",
    requireAuth() {
      throw new Error("Auth access is outside this test.");
    },
    session: {
      auth: {
        current: callerOf(
          options.authenticator ?? "authjs",
          options.attributes
        ),
        initiator: options.initiator ?? null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    turn: {
      id: "turn-1",
      input: [...(options.input ?? [person("сыграем в города?")])],
      sequence: 1,
    },
  };
}

const recalledSchema = z
  .object({
    messages: z.array(z.object({ content: z.string(), id: z.string() })),
  })
  .nullable();

describe("the skills memory slot", () => {
  it("keeps one scope through every kind of turn of a pilot's session", async () => {
    const { skills } = await load();
    const kinds = [
      turnContext({ authenticator: "authjs" }),
      turnContext({ authenticator: "photon-imessage" }),
      turnContext({ authenticator: "telegram-webhook" }),
      turnContext({
        attributes: { browserRunId: "run-1" },
        authenticator: "browser-result",
      }),
      turnContext({ authenticator: "scheduled-result" }),
      turnContext({ authenticator: "scheduled-worker" }),
      turnContext({
        authenticator: "scheduled-worker",
        initiator: callerOf("scheduled-worker", {
          scheduledRunKind: "proactive",
        }),
      }),
    ];
    expect(kinds.map((context) => skills.scope(context))).toEqual(
      kinds.map(() => "skills")
    );
  });

  it("is off outside the pilot and on the Gateway", async () => {
    expect((await load({})).skills.scope(turnContext())).toBeNull();
    expect(
      (
        await load({
          OPENROUTER_API_KEY: "test-openrouter-key",
          SKILLS_WORKSPACES: "workspace-2",
        })
      ).skills.scope(turnContext())
    ).toBeNull();
    expect(
      (await load({ SKILLS_WORKSPACES: "*" })).skills.scope(turnContext())
    ).toBeNull();
    expect(
      (
        await load({
          OPENROUTER_API_KEY: "test-openrouter-key",
          SKILLS_WORKSPACES: "*",
        })
      ).skills.scope(turnContext())
    ).toBe("skills");
  });

  it("attaches a skill the turn needs, once, as its keyed block", async () => {
    const { skillRecord, skills } = await load();
    const recall = skills.provider.recall["turn.started"];
    const setup = { browser: true, images: false };
    const games = skillRecord("games", setup);

    const first = recalledSchema.parse(await recall(turnContext()));
    expect(first).toEqual({
      messages: [{ content: games, id: "skill:games" }],
    });
    // The same turn replayed gets the same answer.
    expect(recalledSchema.parse(await recall(turnContext()))).toEqual(first);

    // A later turn that needs it again returns the same block, which eve
    // leaves where it was; one that needs another adds that one too.
    const history = [person("сыграем?"), record(games ?? "")];
    expect(
      recalledSchema.parse(await recall(turnContext({ history })))
    ).toEqual(first);
    expect(
      recalledSchema.parse(
        await recall(
          turnContext({
            history,
            input: [person("купи билет на сапсан и сыграем")],
          })
        )
      )
    ).toEqual({
      messages: [
        { content: skillRecord("browser", setup), id: "skill:browser" },
        { content: games, id: "skill:games" },
      ],
    });
    // A turn that needs none leaves the block in place.
    expect(
      await recall(turnContext({ history, input: [person("спасибо")] }))
    ).toBeNull();
  });

  it("replaces a block whose rules changed since, needed or not", async () => {
    const { skillRecord, skills } = await load();
    const recalled = recalledSchema.parse(
      await skills.provider.recall["turn.started"](
        turnContext({
          history: [
            person("сыграем?"),
            record(
              '<bro-skill name="games">\n- Старое правило игры.\n</bro-skill>'
            ),
          ],
          input: [person("спасибо")],
        })
      )
    );
    expect(recalled).toEqual({
      messages: [
        {
          content: skillRecord("games", { browser: true, images: false }),
          id: "skill:games",
        },
      ],
    });
  });

  it("puts folded rules back only when a turn needs them", async () => {
    const { skillRecord, skillStub, skills } = await load();
    const recall = skills.provider.recall["turn.started"];
    const history = [person("сыграем?"), record(skillStub("games"))];
    expect(
      await recall(turnContext({ history, input: [person("спасибо")] }))
    ).toBeNull();
    expect(
      recalledSchema.parse(await recall(turnContext({ history })))
    ).toEqual({
      messages: [
        {
          content: skillRecord("games", { browser: true, images: false }),
          id: "skill:games",
        },
      ],
    });
  });

  it("replaces the rules of a skill the setup no longer has", async () => {
    // The browser's block from before, in a deployment without a browser.
    const { skillRecord } = await load();
    const browser =
      skillRecord("browser", { browser: true, images: false }) ?? "";
    const { skillGone, skillStub, skills } = await load({
      OPENROUTER_API_KEY: "test-openrouter-key",
      SKILLS_WORKSPACES: workspaceId,
    });
    const recall = skills.provider.recall["turn.started"];
    const gone = { content: skillGone("browser"), id: "skill:browser" };
    // Its rules or their stub, in a turn that needs them or not.
    const recalled = await Promise.all(
      [browser, skillStub("browser")].flatMap((text) =>
        ["спасибо", "купи билет на сапсан"].map(async (words) =>
          recalledSchema.parse(
            await recall(
              turnContext({ history: [record(text)], input: [person(words)] })
            )
          )
        )
      )
    );
    expect(recalled).toEqual(recalled.map(() => ({ messages: [gone] })));
    // Once gone it stays so, and no turn brings the rules back.
    expect(
      await recall(
        turnContext({
          history: [record(skillGone("browser"))],
          input: [person("спасибо")],
        })
      )
    ).toBeNull();
    expect(skillGone("browser")).not.toContain("вызови");
    // Compaction folds it so too.
    const fold = skills.provider.recall["compaction.completed"];
    expect(
      recalledSchema.parse(
        await fold({
          ...turnContext({
            history: [record(browser)],
            input: [person("купи билет на сапсан")],
          }),
          compaction: { modelId: "deepseek/deepseek-v4.1-flash" },
        })
      )
    ).toEqual({ messages: [gone] });
  });

  it("adds no record for rules `load_skill` already brought", async () => {
    const { skillRecord, skills } = await load();
    const games = skillRecord("games", { browser: true, images: false }) ?? "";
    expect(
      await skills.provider.recall["turn.started"](
        turnContext({
          history: [
            person("сыграем?"),
            {
              content: [
                {
                  input: { name: "games" },
                  toolCallId: "load-1",
                  toolName: "load_skill",
                  type: "tool-call",
                },
              ],
              role: "assistant",
            },
            {
              content: [
                {
                  output: { type: "text", value: games },
                  toolCallId: "load-1",
                  toolName: "load_skill",
                  type: "tool-result",
                },
              ],
              role: "tool",
            },
          ],
        })
      )
    ).toBeNull();
  });

  it("attaches nothing in a worker's turn", async () => {
    const { skills } = await load();
    const recall = skills.provider.recall["turn.started"];
    expect(
      await Promise.all(
        ["scheduled-worker", "scheduled-result"].map(async (authenticator) =>
          recall(turnContext({ authenticator }))
        )
      )
    ).toEqual([null, null]);
  });

  it("attaches the browser's rules to a browser run's report", async () => {
    const { skillRecord, skills } = await load();
    const recalled = recalledSchema.parse(
      await skills.provider.recall["turn.started"](
        turnContext({
          attributes: { browserRunId: "run-1" },
          authenticator: "browser-result",
          input: [person("Browser run run-1 finished.")],
        })
      )
    );
    expect(recalled?.messages).toEqual([
      {
        content: skillRecord("browser", {
          browser: true,
          images: false,
        }),
        id: "skill:browser",
      },
    ]);
  });

  it("fails no turn: a recall that breaks attaches nothing", async () => {
    const { skills } = await load();
    const broken = turnContext();
    Object.defineProperty(broken.turn, "input", {
      get() {
        throw new Error("broken input");
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await skills.provider.recall["turn.started"](broken)).toBeNull();
  });

  it("folds after compaction the rules the turn does not need", async () => {
    const { skillRecord, skillStub, skills } = await load();
    const fold = skills.provider.recall["compaction.completed"];
    const setup = { browser: true, images: false };
    const history = [
      record(skillRecord("browser", setup) ?? ""),
      record(skillRecord("games", setup) ?? ""),
      person("купи билет на сапсан"),
    ];
    const during = {
      ...turnContext({ history, input: [person("купи билет на сапсан")] }),
      compaction: { modelId: "deepseek/deepseek-v4.1-flash" },
    };
    expect(recalledSchema.parse(await fold(during))).toEqual({
      messages: [{ content: skillStub("games"), id: "skill:games" }],
    });
    // Between turns nothing is needed but what the history keeps.
    expect(recalledSchema.parse(await fold({ ...during, turn: null }))).toEqual(
      {
        messages: [
          { content: skillStub("browser"), id: "skill:browser" },
          { content: skillStub("games"), id: "skill:games" },
        ],
      }
    );
    // A stub stays a stub, and a fold that breaks folds nothing.
    expect(
      await fold({
        ...during,
        messages: [record(skillStub("games"))],
        turn: null,
      })
    ).toBeNull();
    const broken = { ...during };
    Object.defineProperty(broken, "messages", {
      get() {
        throw new Error("broken history");
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await fold(broken)).toBeNull();
  });

  it("comes before the profile's records in a turn", () => {
    // eve inserts a turn's records by the slots' file names: the profile's
    // note changes with the request and must not stand before a block.
    const slots = readdirSync(
      new URL("../../../agent/memory/", import.meta.url)
    )
      .filter((file) => file.endsWith(".ts"))
      .toSorted((first, second) => first.localeCompare(second));
    expect(slots[0]).toBe("bro_skills.ts");
  });

  it("hides from the person's words and language, between Bro's question and the answer", async () => {
    const { language, personWordsThisTurn, skillRecord } = await load();
    const question = "Сапсан 18:40, итого 4 320 ₽. Оплачиваю?";
    const block = record(
      skillRecord("games", {
        browser: true,
        images: false,
      }) ?? ""
    );
    const sent: ModelMessage[] = [
      {
        content: [
          {
            input: { text: question },
            toolCallId: "send-1",
            toolName: "send_message",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "json", value: { status: "sent" } },
            toolCallId: "send-1",
            toolName: "send_message",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];
    expect(
      personWordsThisTurn([person("купи сапсан"), ...sent, block, person("да")])
    ).toEqual({ answers: [], paymentAsked: question, said: ["да"] });
    expect(language([person("Find me a train to Kazan"), block])).toBe("en");
  });
});

async function resolveTool(
  loaded: Awaited<ReturnType<typeof load>>,
  context = turnContext()
) {
  const resolve = loaded.loadSkill.events["step.started"];
  return resolve ? await resolve({}, context) : null;
}

const executableSchema = z.object({
  execute: z.custom<(input: { name: string }) => string>(
    (value) => z.function().safeParse(value).success
  ),
});

/** What `load_skill` answers the model for a name. */
function run(tool: Awaited<ReturnType<typeof resolveTool>>, name: string) {
  return executableSchema.parse(tool).execute({ name });
}

describe("load_skill", () => {
  it("is no tool outside the pilot or in a worker's turn", async () => {
    expect(await resolveTool(await load({}))).toBeNull();
    expect(
      await resolveTool(
        await load(),
        turnContext({ authenticator: "scheduled-worker" })
      )
    ).toBeNull();
  });

  it("gives the rules of a skill as the block the slot attaches", async () => {
    const loaded = await load();
    const tool = await resolveTool(loaded);
    expect(run(tool, "games")).toBe(
      loaded.skillRecord("games", {
        browser: true,
        images: false,
      })
    );
  });

  it("names the skills for a name that is none of them", async () => {
    const tool = await resolveTool(await load());
    // The other marked files bring their skills too.
    expect(run(tool, "weather")).toMatch(
      /^There is no skill «weather»\. The skills are: browser, .*\bgames\b.*\.$/u
    );
  });

  it("points to the block already above instead of a second copy", async () => {
    const loaded = await load();
    const games = loaded.skillRecord("games", {
      browser: true,
      images: false,
    });
    const tool = await resolveTool(
      loaded,
      turnContext({ history: [person("сыграем"), record(games ?? "")] })
    );
    expect(run(tool, "games")).toContain("already above");
  });

  it("counts a block an earlier step of the turn loaded", async () => {
    const loaded = await load();
    const games =
      loaded.skillRecord("games", { browser: true, images: false }) ?? "";
    const tool = await resolveTool(
      loaded,
      turnContext({
        history: [
          person("сыграем"),
          {
            content: [
              {
                input: { name: "games" },
                toolCallId: "load-1",
                toolName: "load_skill",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { type: "text", value: games },
                toolCallId: "load-1",
                toolName: "load_skill",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
        ],
      })
    );
    expect(run(tool, "games")).toContain("already above");
  });

  it("takes a short name, trimmed", async () => {
    const schema = z.object({
      inputSchema: z.custom<z.ZodType>((value) => value instanceof z.ZodType),
    });
    const { inputSchema } = schema.parse(await resolveTool(await load()));
    expect(inputSchema.safeParse({ name: " games " }).data).toEqual({
      name: "games",
    });
    expect(inputSchema.safeParse({ name: "x".repeat(65) }).success).toBe(false);
    expect(inputSchema.safeParse({ name: "  " }).success).toBe(false);
  });
});
