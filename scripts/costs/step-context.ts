import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import type { DynamicResolveContext } from "eve/tools";
import type profileMemory from "../../agent/memory/profile.ts";
import type calendar from "../../agent/tools/calendar.ts";
import { z } from "zod";
import { registerApplicationModuleResolution } from "../lib/module-resolution.ts";

/**
 * What one step of the main agent sends to the model, by kind of turn.
 *
 *   node --experimental-strip-types scripts/costs/step-context.ts [--tools] [--dump <dir>]
 *
 * It renders the authored instructions the way `agent/instructions/*.ts`
 * picks them per mode, resolves every tool module of `agent/tools/` and the
 * memory providers against a fake caller of that kind, and serializes each
 * tool's input schema the way eve does (`eve/dist/src/tools/schema.js`: the
 * zod Standard Schema's draft-07 input JSON Schema). Nothing reaches the
 * database or a model: a resolver that would read the database fails, and
 * the table names it. `--tools` prints every web tool's size; `--dump <dir>`
 * writes each kind's system prompt and tool catalog to count with a real
 * tokenizer.
 *
 * It measures both ways a step is built: as today, and in the pilot of the
 * cache-friendly step (STEP_CONTEXT_WORKSPACES, `stepContextPilot`), where
 * the clock leaves the instructions for the step's note after the history,
 * `send_message` is the last tool, and a browser report's turn keeps only
 * `reportToolsAfterOutcome` once its message is out. The cache columns are
 * estimates from where each prefix breaks, not a measurement of a host.
 *
 * Tokens are estimated from characters with ratios measured on the DeepSeek
 * V3.1 tokenizer (`deepseek-ai/DeepSeek-V3.1`, `tokenizer.json`) on these
 * same texts on 30.09.2026: 3.1 characters per token for the Russian
 * instructions, 3.7 for the tool catalog (English descriptions in JSON).
 * The results are in `docs/agent-costs.md`, section 3.2.
 */

const charsPerToken = { instructions: 3.1, tools: 3.7 } as const;

// Placeholders for the environment the modules validate on import; none of
// them reaches a service. The keys make the deployment look like production,
// where Browser Use, OpenRouter and Composio are configured.
const placeholderEnvironment = {
  BETTER_AUTH_SECRET: "step-context-placeholder-secret-0123456789",
  BETTER_AUTH_URL: "http://127.0.0.1:9",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_placeholder",
  BROWSER_USE_API_KEY: "placeholder",
  COMPOSIO_API_KEY: "placeholder",
  COMPOSIO_GOOGLE_AUTH_CONFIG_ID: "ac_placeholder",
  COMPOSIO_NOTION_AUTH_CONFIG_ID: "ac_placeholder",
  COMPOSIO_SLACK_AUTH_CONFIG_ID: "ac_placeholder",
  DATABASE_URL: "postgresql://user:password@127.0.0.1:9/database",
  OPENROUTER_API_KEY: "placeholder",
  SECRET_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
};
// oxlint-disable-next-line eslint/no-restricted-properties -- this measurement sets placeholders for its own process before any module validates them
Object.assign(process.env, placeholderEnvironment);

registerApplicationModuleResolution();
// `?raw` markdown imports are a bundler contract, like the aliases.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith("?raw")) return nextLoad(url, context);
    const text = readFileSync(fileURLToPath(url.slice(0, -4)), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(text)};`,
    };
  },
  resolve(specifier, context, nextResolve) {
    if (!specifier.endsWith("?raw") || context.parentURL === undefined) {
      return nextResolve(specifier, context);
    }
    return {
      shortCircuit: true,
      url: new URL(specifier, context.parentURL).href,
    };
  },
});

const root = new URL("../../", import.meta.url);
const content = (path: string) =>
  readFileSync(new URL(`agent/instructions/content/${path}`, root), "utf8");

type Mode =
  | "interactive"
  | "proactive-worker"
  | "scheduled-report"
  | "scheduled-worker";

/** A kind of turn: who opens it, where, and what its first step withholds. */
interface Kind {
  readonly attributes: Readonly<Record<string, string>>;
  readonly authenticator: string;
  readonly channel: string;
  readonly initiator: Readonly<Record<string, string>> | null;
  readonly label: string;
  readonly mode: Mode;
  readonly withheld: readonly string[];
}

const kinds: readonly Kind[] = [
  {
    attributes: {},
    authenticator: "authjs",
    channel: "channel:eve",
    initiator: null,
    label: "Сообщение в вебе",
    mode: "interactive",
    withheld: [],
  },
  {
    attributes: {},
    authenticator: "telegram-webhook",
    channel: "channel:telegram",
    initiator: null,
    label: "Сообщение в Telegram",
    mode: "interactive",
    withheld: [],
  },
  {
    attributes: { browserRunId: "run-1" },
    authenticator: "browser-result",
    channel: "channel:eve",
    initiator: null,
    label: "Ход-отчёт браузера",
    mode: "interactive",
    // What the first step's model selection withholds (`agent/agent.ts`): a
    // report turn asks no question, and a browser report holds its card
    // tools until its message is out.
    withheld: ["ask_question", "card tools"],
  },
  {
    attributes: {},
    authenticator: "scheduled-worker",
    channel: "channel:scheduled-run",
    initiator: null,
    label: "Воркер расписания",
    mode: "scheduled-worker",
    withheld: [],
  },
  {
    attributes: {},
    authenticator: "scheduled-worker",
    channel: "channel:scheduled-run",
    initiator: { scheduledRunKind: "proactive" },
    label: "Проактивный воркер",
    mode: "proactive-worker",
    withheld: [],
  },
  {
    attributes: {},
    authenticator: "scheduled-result",
    channel: "channel:eve",
    initiator: null,
    label: "Отчёт расписания",
    mode: "scheduled-report",
    withheld: ["ask_question"],
  },
];

function contextOf(kind: Kind) {
  const current = {
    attributes: { ...kind.attributes, workspaceId: "personal:workspace" },
    authenticator: kind.authenticator,
    principalId: "user-1",
    principalType: "user" as const,
  };
  return {
    channel: { kind: kind.channel, metadata: {} },
    messages: [{ content: "Привет! Что у меня завтра?", role: "user" }],
    model: null,
    session: {
      auth: {
        current,
        initiator: kind.initiator
          ? {
              ...current,
              attributes: { ...current.attributes, ...kind.initiator },
            }
          : null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}

/**
 * The system prompt of a turn, in eve's order: `agent/instructions.md`, then
 * the dynamic instructions in file order. Each entry mirrors the mode table
 * of its `agent/instructions/*.ts`; the parts read from the database (time
 * zone, spend limit, form of address, acquaintance) take their usual shape
 * for a person with no limit and «ты».
 */
async function instructionParts(mode: Mode, pilot = false) {
  const [
    { localTimeInstructions },
    { spendLimitInstructions },
    { stepNoteInstructions },
    { saveTimeZoneInstruction },
  ] = await Promise.all([
    import("../../agent/instructions/50-local-time.ts"),
    import("../../agent/instructions/15-autonomy.ts"),
    import("../../agent/lib/step-context/note.ts"),
    import("../../agent/lib/local-time.ts"),
  ]);
  const interactive = mode === "interactive";
  const worker = mode === "scheduled-worker";
  const parts: (readonly [string, string | null])[] = [
    [
      "instructions.md",
      readFileSync(new URL("agent/instructions.md", root), "utf8"),
    ],
    [
      "10 execution-safety",
      interactive || worker ? content("execution-safety.md") : null,
    ],
    [
      "15 autonomy (+ follow-through, лимит)",
      interactive || worker
        ? [
            content("autonomy.md"),
            interactive ? content("follow-through.md") : null,
            spendLimitInstructions(undefined, []),
          ]
            .filter((part) => part !== null)
            .join("\n")
        : null,
    ],
    ["20 role", content(`role/${mode}.md`)],
    [
      "25 recommendations",
      interactive || worker ? content("recommendations.md") : null,
    ],
    [
      "30 message-style",
      interactive || mode === "scheduled-report"
        ? content("message-style.md")
        : null,
    ],
    [
      "40 browser",
      interactive || worker ? content("browser/available.md") : null,
    ],
    [
      "45 public-services",
      interactive
        ? `${content("meter-readings.md")}\n${content("public-services.md")}`
        : null,
    ],
    [
      "50 local-time",
      pilot
        ? [
            stepNoteInstructions,
            interactive || worker ? saveTimeZoneInstruction : null,
          ]
            .filter((part) => part !== null)
            .join("\n")
        : localTimeInstructions(
            new Date("2026-09-30T09:41:00Z"),
            "Europe/Moscow",
            interactive || worker
          ),
    ],
    [
      "60 creative",
      interactive
        ? `${content("creative/images.md")}\n${content("creative/games.md")}`
        : null,
    ],
    [
      "60 hard-constraints",
      interactive || worker ? content("hard-constraints.md") : null,
    ],
    [
      "70 acquaintance",
      interactive
        ? "Вы с этим человеком уже знакомы по другим разговорам. Новый чат — не новое знакомство: не представляйся и не перечисляй, что умеешь, пока он сам не спросит."
        : null,
    ],
  ];
  return parts.flatMap(([name, text]) =>
    text === null ? [] : [[name, text] as const]
  );
}

/** A zod Standard Schema, which emits its own JSON Schema. */
const inputSchemaSchema = z.object({
  "~standard": z.object({
    jsonSchema: z.object({
      input: z.custom<(options: { readonly target: "draft-07" }) => object>(
        (value) => z.function().safeParse(value).success
      ),
    }),
  }),
});

const toolSchema = z.object({
  description: z.string().optional(),
  inputSchema: inputSchemaSchema.optional(),
});

/** One tool rather than a set of them: it runs. */
const singleToolSchema = toolSchema.extend({
  execute: z.custom<() => void>(
    (value) => z.function().safeParse(value).success
  ),
});

const emittedSchema = z.looseObject({ $schema: z.string().optional() });

type Tool = z.infer<typeof toolSchema>;

/** A tool as the provider receives it: name, description, parameters. */
function advertised(name: string, tool: Tool) {
  const emitted = tool.inputSchema?.["~standard"].jsonSchema.input({
    target: "draft-07",
  });
  const { $schema: _dialect, ...parameters } = emittedSchema.parse(
    emitted ?? {}
  );
  return JSON.stringify({
    function: { description: tool.description, name, parameters },
    type: "function",
  });
}

const resolverSchema = z.custom<
  NonNullable<(typeof calendar)["events"]["turn.started"]>
>((value) => z.function().safeParse(value).success);

const toolModuleSchema = z.union([
  z.object({
    default: z.object({
      events: z.object({
        "step.started": resolverSchema.optional(),
        "turn.started": resolverSchema.optional(),
      }),
    }),
  }),
  z.object({ default: toolSchema }),
]);

const memoryModuleSchema = z.object({
  default: z.object({
    provider: z.object({
      tools: z.custom<NonNullable<(typeof profileMemory)["provider"]["tools"]>>(
        (value) => z.function().safeParse(value).success
      ),
    }),
  }),
});

async function moduleTools(file: string, kind: Kind) {
  const toolModule = toolModuleSchema.parse(
    await import(new URL(`agent/tools/${file}`, root).href)
  );
  const name = file.replace(/\.ts$/u, "");
  if (!("events" in toolModule.default)) {
    return [[name, advertised(name, toolModule.default)] as const];
  }
  const { events } = toolModule.default;
  const resolve = events["step.started"] ?? events["turn.started"];
  if (!resolve) return [];
  // A module resolves to a set of tools, one tool, or nothing in this mode.
  const resolved = await resolve({}, contextOf(kind));
  if (!resolved) return [];
  const single = singleToolSchema.safeParse(resolved);
  if (single.success) return [[name, advertised(name, single.data)] as const];
  return Object.entries(z.record(z.string(), toolSchema).parse(resolved)).map(
    ([toolName, tool]) => [toolName, advertised(toolName, tool)] as const
  );
}

async function memoryTools(slot: string, kind: Kind) {
  const memory = memoryModuleSchema.parse(
    await import(new URL(`agent/memory/${slot}.ts`, root).href)
  );
  const resolved = z
    .record(z.string(), toolSchema)
    .nullable()
    .parse(
      await memory.default.provider.tools({
        ...contextOf(kind),
        memory: {
          scope: { key: `${slot}-key`, namespace: slot, value: "workspace" },
          slot,
        },
        turn: { id: "turn-1", input: [], sequence: 1 },
      })
    );
  return Object.entries(resolved ?? {}).map(
    ([toolName, tool]) =>
      [
        `${slot}__${toolName}`,
        advertised(`${slot}__${toolName}`, tool),
      ] as const
  );
}

async function toolsOf(kind: Kind) {
  const files = readdirSync(new URL("agent/tools/", root)).filter((file) =>
    file.endsWith(".ts")
  );
  const settled = await Promise.allSettled([
    ...files.map(async (file) => moduleTools(file, kind)),
    ...["personal_info", "profile", "workstreams"].map(async (slot) =>
      memoryTools(slot, kind)
    ),
  ]);
  const sources = [...files, "personal_info", "profile", "workstreams"];
  return {
    failures: settled.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${sources[index] ?? "?"}: ${String(result.reason).slice(0, 80)}`]
        : []
    ),
    tools: new Map(
      settled.flatMap((result) =>
        result.status === "fulfilled" ? result.value : []
      )
    ),
  };
}

const tokens = (chars: number, ratio: number) => Math.round(chars / ratio);
const thousands = (value: number) => (value / 1000).toFixed(1);
const totalLength = (texts: Iterable<string>) =>
  [...texts].reduce((sum, text) => sum + text.length, 0);

const { cardToolsBeforeOutcome, reportToolsAfterOutcome } =
  await import("../../agent/lib/delivery/browser-report.ts");

const dumpIndex = process.argv.indexOf("--dump");
const dumpDirectory =
  dumpIndex === -1 ? undefined : process.argv[dumpIndex + 1];
if (dumpDirectory) mkdirSync(dumpDirectory, { recursive: true });

const measured = await Promise.all(
  kinds.map(async (kind) => {
    const [parts, pilotParts, { failures, tools }] = await Promise.all([
      instructionParts(kind.mode),
      instructionParts(kind.mode, true),
      toolsOf(kind),
    ]);
    if (dumpDirectory) {
      const base = `${dumpDirectory}/${kind.authenticator}-${kind.mode}`;
      writeFileSync(
        `${base}.system.md`,
        parts.map(([, text]) => text).join("\n\n")
      );
      writeFileSync(`${base}.tools.json`, `[${[...tools.values()].join(",")}]`);
    }
    const withheld = new Set<string>(
      kind.withheld.flatMap((name) =>
        name === "card tools" ? cardToolsBeforeOutcome : [name]
      )
    );
    const instructionTokens = tokens(
      totalLength(parts.map(([, text]) => text)),
      charsPerToken.instructions
    );
    const toolTokens = tokens(totalLength(tools.values()), charsPerToken.tools);
    const firstStepTokens = tokens(
      totalLength(
        [...tools].flatMap(([name, json]) => (withheld.has(name) ? [] : [json]))
      ),
      charsPerToken.tools
    );
    const toolTokensOf = (keep: (name: string) => boolean) =>
      tokens(
        totalLength(
          [...tools].flatMap(([name, json]) => (keep(name) ? [json] : []))
        ),
        charsPerToken.tools
      );
    const instructionText = (of: typeof parts) =>
      totalLength(of.map(([, text]) => text));
    const clockIndex = parts.findIndex(([name]) => name === "50 local-time");
    return {
      cache: {
        afterMessage: kind.withheld.includes("card tools")
          ? {
              now: toolTokensOf((name) => name !== "ask_question"),
              pilot: toolTokensOf((name) =>
                reportToolsAfterOutcome.some((kept) => kept === name)
              ),
            }
          : undefined,
        beforeClock: tokens(
          instructionText(parts.slice(0, clockIndex)),
          charsPerToken.instructions
        ),
        clock: tokens(
          parts[clockIndex]?.[1].split("\n")[0]?.length ?? 0,
          charsPerToken.instructions
        ),
        instructions: instructionTokens,
        kind,
        pilotInstructions: tokens(
          instructionText(pilotParts),
          charsPerToken.instructions
        ),
        replyTool: toolTokensOf((name) => name === "send_message"),
        stepTools: withheld.size > 0 ? firstStepTokens : toolTokens,
      },
      row: [
        kind.label,
        thousands(instructionTokens),
        String(tools.size),
        thousands(toolTokens),
        withheld.size > 0 ? thousands(firstStepTokens) : "—",
        thousands(instructionTokens + toolTokens),
        failures.join("; ") || "—",
      ],
      tools,
    };
  })
);

console.log(
  "| Вид хода | Инструкции, тыс. | Инструментов | Схемы, тыс. | Схемы 1-го шага, тыс. | Без истории, тыс. | Не разрешилось |"
);
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const { row } of measured) console.log(`| ${row.join(" | ")} |`);

console.log("\nИнструкции по частям, тыс. токенов:");
const modes = [
  "interactive",
  "scheduled-worker",
  "proactive-worker",
  "scheduled-report",
] as const;
const partsByMode = await Promise.all(
  modes.map(async (mode) => instructionParts(mode))
);
for (const [index, parts] of partsByMode.entries()) {
  const sizes = parts.map(
    ([name, text]) =>
      `${name} ${thousands(tokens(text.length, charsPerToken.instructions))}`
  );
  // The clock changes every turn: what follows it is a new prefix.
  const clock = parts.findIndex(([name]) => name === "50 local-time");
  const beforeClock = totalLength(
    parts.slice(0, clock).map(([, text]) => text)
  );
  console.log(`  ${modes[index] ?? ""}: ${sizes.join(", ")}`);
  console.log(
    `    до строки времени ${thousands(tokens(beforeClock, charsPerToken.instructions))}`
  );
}

// Where the cached prefix of a step ends, as today and in the pilot. Today
// the clock breaks it in the instructions on every step (and the system note
// DeepSeek moves before the history on every later one), so only the
// instructions before the clock are read from the cache. In the pilot the
// instructions, the schemas and the earlier history are one stable prefix;
// it breaks only where the tool set or `send_message`'s schema changes.
// Prices: RouterAI, `deepseek/deepseek-v4.1-flash`, roubles per million.
const inputPrice = 9.66;
const cachedPrice = 1.21;
/** The reply directive and the other notes of a step writing to the person. */
const replyNoteTokens = 250;
function estimate(input: number, cached: number) {
  const roubles = ((input - cached) * inputPrice + cached * cachedPrice) / 1e6;
  return `${thousands(input)} / ${thousands(cached)} / ${roubles.toFixed(2)}`;
}
console.log(
  "\nКэш шага без истории (STEP_CONTEXT_WORKSPACES): вход / из кэша, тыс. токенов / ₽ за шаг. Прежнюю историю пилот читает из кэша, кроме шагов со сменой схем; сейчас — всегда полной ценой."
);
console.log("| Вид хода | Шаг | Сейчас | Пилот |");
console.log("| --- | --- | --- | --- |");
for (const { cache } of measured) {
  const writes =
    cache.kind.mode === "interactive" || cache.kind.mode === "scheduled-report";
  const note = writes ? replyNoteTokens : 0;
  const now = (tools: number) =>
    estimate(cache.instructions + tools + note, cache.beforeClock);
  const pilot = (tools: number, cached: number) =>
    estimate(cache.pilotInstructions + tools + note + cache.clock, cached);
  const steady = cache.pilotInstructions + cache.stepTools;
  const row = (step: string, today: string, piloted: string) => {
    console.log(`| ${cache.kind.label} | ${step} | ${today} | ${piloted} |`);
  };
  const after = cache.afterMessage;
  if (cache.kind.mode !== "interactive") {
    row("каждый", now(cache.stepTools), pilot(cache.stepTools, steady));
  } else if (after === undefined) {
    // A forced step requires `text` in `send_message` and the next one does
    // not: the turn's first step and the one after the reply. With the tool
    // last, only its schema and the history after it are re-read.
    row(
      "1-й и после ответа (схема send_message)",
      now(cache.stepTools),
      pilot(cache.stepTools, steady - cache.replyTool)
    );
    row("прочие", now(cache.stepTools), pilot(cache.stepTools, steady));
  } else {
    // The card tools are held back from the first step: the set differs
    // from the last turn's, so only the instructions are read from cache.
    row(
      "1-й (без карточек)",
      now(cache.stepTools),
      pilot(cache.stepTools, cache.pilotInstructions)
    );
    row(
      "до сообщения, следующие",
      now(cache.stepTools),
      pilot(cache.stepTools, steady)
    );
  }
  if (after) {
    console.log(
      `| ${cache.kind.label} | 1-й после сообщения (смена набора) | ${now(after.now)} | ${pilot(after.pilot, cache.pilotInstructions)} |`
    );
    console.log(
      `| ${cache.kind.label} | следующие после сообщения | ${now(after.now)} | ${pilot(after.pilot, cache.pilotInstructions + after.pilot)} |`
    );
  }
}

if (process.argv.includes("--tools")) {
  const web = measured[0]?.tools ?? new Map<string, string>();
  console.log("\nСхемы инструментов в вебе, токенов:");
  for (const [name, json] of [...web].toSorted(
    (a, b) => b[1].length - a[1].length
  )) {
    console.log(
      `  ${name} ${String(tokens(json.length, charsPerToken.tools))}`
    );
  }
}

// Pools opened by an imported module would keep the process alive.
process.exit(0);
