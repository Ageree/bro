import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import type { JSONSchema7, ModelMessage } from "ai";
import type { DynamicResolveContext } from "eve/tools";
import { z } from "zod";
import type profileMemory from "@agent/memory/profile";
import type calendar from "@agent/tools/calendar";

/**
 * The tool catalog a step of the main agent is offered before the step's
 * model selection filters it: every module of `agent/tools/` and the memory
 * providers, resolved against a caller of one kind of turn, each tool as the
 * provider receives it (`type`, `name`, `description`, `inputSchema` — the
 * zod Standard Schema's draft-07 input JSON Schema, as eve emits it). The
 * order follows eve's (`eve/dist/src/context/build-dynamic-tools.js`): static
 * tools, then step-scoped resolvers, then turn-scoped ones, then memory.
 * A test that uses it sets the deployment first (`stubDeployment`).
 */

const toolsDirectory = new URL("../../agent/tools/", import.meta.url);
const memoryDirectory = new URL("../../agent/memory/", import.meta.url);

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

/** A JSON Schema as zod emits it. */
const emittedSchema = z.custom<JSONSchema7>(
  (value) => z.looseObject({}).safeParse(value).success
);

/** A function tool as a step's model call carries it. */
export interface CatalogTool {
  readonly description?: string;
  readonly inputSchema: JSONSchema7;
  readonly name: string;
  readonly type: "function";
}

function advertised(name: string, tool: z.infer<typeof toolSchema>) {
  const emitted = tool.inputSchema?.["~standard"].jsonSchema.input({
    target: "draft-07",
  });
  const { $schema: _dialect, ...inputSchema } = emittedSchema.parse(
    emitted ?? { type: "object" }
  );
  const type = "function";
  return tool.description === undefined
    ? ({ inputSchema, name, type } satisfies CatalogTool)
    : ({
        description: tool.description,
        inputSchema,
        name,
        type,
      } satisfies CatalogTool);
}

type Resolver = z.infer<typeof resolverSchema>;

function resolvedTools(
  name: string,
  resolved: Awaited<ReturnType<Resolver>>
): CatalogTool[] {
  if (!resolved) return [];
  const single = singleToolSchema.safeParse(resolved);
  if (single.success) return [advertised(name, single.data)];
  return Object.entries(z.record(z.string(), toolSchema).parse(resolved)).map(
    ([toolName, tool]) => advertised(toolName, tool)
  );
}

/** A caller of a kind of turn, in a workspace, with its messages so far. */
export function catalogContext(
  kind: keyof typeof catalogKinds,
  messages: readonly ModelMessage[] = []
) {
  const { attributes, authenticator, channel, initiator } = catalogKinds[kind];
  const current = {
    attributes: { ...attributes, workspaceId: "workspace-1" },
    authenticator,
    principalId: "user-1",
    principalType: "user" as const,
  };
  return {
    channel: { kind: channel, metadata: {} },
    messages,
    model: null,
    session: {
      auth: {
        current,
        initiator: initiator
          ? { ...current, attributes: { ...current.attributes, ...initiator } }
          : null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}

/** Every kind of turn whose tools differ, or might. */
export const catalogKinds = {
  "browser-report": {
    attributes: { browserRunId: "run-1" },
    authenticator: "browser-result",
    channel: "channel:eve",
    initiator: null,
  },
  "proactive-worker": {
    attributes: {},
    authenticator: "scheduled-worker",
    channel: "channel:scheduled-run",
    initiator: { scheduledRunKind: "proactive" },
  },
  "scheduled-report": {
    attributes: {},
    authenticator: "scheduled-result",
    channel: "channel:eve",
    initiator: null,
  },
  "scheduled-worker": {
    attributes: {},
    authenticator: "scheduled-worker",
    channel: "channel:scheduled-run",
    initiator: null,
  },
  telegram: {
    attributes: {},
    authenticator: "telegram-webhook",
    channel: "channel:telegram",
    initiator: null,
  },
  web: {
    attributes: {},
    authenticator: "authjs",
    channel: "channel:eve",
    initiator: null,
  },
} as const;

/** The catalog of one step, in eve's order. */
export async function toolCatalog(
  context: DynamicResolveContext,
  event: Parameters<Resolver>[0] = {}
) {
  const files = readdirSync(toolsDirectory)
    .filter((file) => file.endsWith(".ts"))
    .toSorted();
  const modules = await Promise.all(
    files.map(async (file) => ({
      module: toolModuleSchema.parse(
        await import(new URL(file, toolsDirectory).href)
      ),
      name: file.replace(/\.ts$/u, ""),
    }))
  );
  const scoped = async (scope: "step.started" | "turn.started") =>
    (
      await Promise.all(
        modules.map(async ({ module, name }) => {
          if (!("events" in module.default)) return [];
          const resolve = module.default.events[scope];
          return resolve
            ? resolvedTools(name, await resolve(event, context))
            : [];
        })
      )
    ).flat();
  const staticTools = modules.flatMap(({ module, name }) =>
    "events" in module.default ? [] : [advertised(name, module.default)]
  );
  const memory = (
    await Promise.all(
      ["personal_info", "profile", "workstreams"].map(async (slot) => {
        const provider = memoryModuleSchema.parse(
          await import(new URL(`${slot}.ts`, memoryDirectory).href)
        ).default.provider;
        const resolved = z
          .record(z.string(), toolSchema)
          .nullable()
          .parse(
            await provider.tools({
              ...context,
              memory: {
                scope: { key: `${slot}-key`, namespace: slot, value: "w" },
                slot,
              },
              turn: { id: "turn-1", input: [], sequence: 1 },
            })
          );
        return Object.entries(resolved ?? {}).map(([name, tool]) =>
          advertised(`${slot}__${name}`, tool)
        );
      })
    )
  ).flat();
  const ordered = [
    ...staticTools,
    ...(await scoped("step.started")),
    ...(await scoped("turn.started")),
    ...memory,
  ];
  // eve keeps the first tool of a name (`build-dynamic-tools.js`).
  return ordered.filter(
    (tool, index) =>
      ordered.findIndex(({ name }) => name === tool.name) === index
  );
}

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** The bytes of a step's tools, as one hash. */
export function toolsDigest(tools: readonly unknown[] | undefined) {
  return sha256(JSON.stringify(tools ?? []));
}
