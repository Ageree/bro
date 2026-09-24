import { describe, expect, it } from "vitest";
import { defineDurableCallback, defineTool } from "eve/tools";

/**
 * Dynamic tool callbacks live in an in-process registry, while their metadata
 * is persisted with the session. A step that runs in a fresh process (after a
 * deploy or a cold start) has to rebind them before the turn goes on. eve's
 * rebind helpers are internal, so the test loads the patched modules by path
 * (`patches/eve@0.62.0.patch`) and declares only the shapes it uses.
 */
interface ContextKey {
  readonly name: string;
}

interface Principal {
  readonly attributes: Readonly<Record<string, string>>;
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
}

interface ToolMetadata {
  readonly name: string;
  readonly resolverSlug: string;
}

interface MemoryLock {
  readonly namespaceKey: string;
  readonly scope: { readonly key: string };
  readonly scopeKey: string;
  readonly slot: string;
  readonly turn: { readonly id: string; readonly sequence: number };
}

interface SessionValue {
  readonly auth: {
    readonly current: Principal | null;
    readonly initiator: Principal;
  };
  readonly sessionId: string;
  readonly turn: { readonly id: string; readonly sequence: number };
}

type ContextValue =
  | MemoryLock
  | Principal
  | SessionValue
  | string
  | null
  | Readonly<Record<string, MemoryLock>>;

interface Context {
  /** The test reads back only the turn's dynamic tool metadata. */
  get(key: ContextKey): readonly ToolMetadata[] | undefined;
  set(key: ContextKey, value: ContextValue): void;
  setVirtualContext(key: ContextKey, value: ContextValue): void;
}

/** eve's serialized context, passed back to it unchanged. */
interface SerializedContext {
  readonly serialized: never;
}

interface TurnEvent {
  readonly data: { readonly sequence: number; readonly turnId: string };
  readonly type: "turn.started";
}

interface ResolveContext {
  readonly session: {
    readonly auth: { readonly current: Principal | null };
  };
}

type Tools = Readonly<Record<string, ReturnType<typeof durableTool>>>;
type TurnResolver = (
  event: TurnEvent,
  context: ResolveContext
) => Tools | null | Promise<Tools | null>;

interface Resolver {
  readonly eventNames: readonly string[];
  readonly events: Readonly<Record<string, TurnResolver>>;
  readonly logicalPath: string;
  readonly rebindMissingCallbacks?: boolean;
  readonly slug: string;
}

interface ToolInput {
  readonly query: string;
}

interface ToolResult {
  readonly input: ToolInput;
  readonly tool: string;
}

interface ToolCallOptions {
  readonly abortSignal: AbortSignal;
  readonly messages: readonly never[];
  readonly toolCallId: string;
}

interface ReplayedTool {
  readonly execute: (
    input: ToolInput,
    options: ToolCallOptions
  ) => Promise<ToolResult>;
  readonly name: string;
}

interface ToolEventInput {
  readonly ctx: Context;
  readonly event: TurnEvent;
  readonly messages: readonly never[];
  readonly resolvers: readonly Resolver[];
}

interface EveInternals {
  buildDynamicTools(ctx: Context): ReplayedTool[];
  clearDurableDynamicCallbacks(sessionId: string): void;
  ContextContainer: new () => Context;
  contextStorage: { run<T>(ctx: Context, run: () => T): T };
  createMemoryToolDynamicDefinition(
    definition: {
      provider: { tools(context: ResolveContext): Tools | null };
    },
    slot: string
  ): { events: Readonly<Record<string, TurnResolver>> };
  createTurnStartedEvent(input: {
    sequence: number;
    turnId: string;
  }): TurnEvent;
  deserializeContext(serialized: SerializedContext): Promise<Context>;
  dispatchDynamicToolEvent(input: ToolEventInput): Promise<void>;
  keys: Readonly<
    Record<
      | "AuthKey"
      | "SessionIdKey"
      | "SessionKey"
      | "StaticModelReferenceKey"
      | "TurnDynamicToolMetadataKey"
      | "TurnMemoryLocksKey",
      ContextKey
    >
  >;
  rebindMissingCompiledDynamicToolCallbacks(
    input: ToolEventInput & { readonly turnInProgress?: boolean }
  ): Promise<void>;
  serializeContext(ctx: Context): SerializedContext;
}

function importInternal(path: string) {
  return import(
    /* @vite-ignore */ new URL(
      `../../node_modules/eve/dist/src/${path}`,
      import.meta.url
    ).href
  );
}

async function loadInternal(path: string) {
  // SAFETY: the modules loadEve() merges together export every function `EveInternals` declares.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- eve does not export these internal modules' types.
  return (await importInternal(path)) as Omit<EveInternals, "keys">;
}

async function loadKeys() {
  // SAFETY: `context/keys.js` exports each key `EveInternals["keys"]` names.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- eve does not export this internal module's types.
  return (await importInternal("context/keys.js")) as EveInternals["keys"];
}

async function loadEve(): Promise<EveInternals> {
  const [
    keys,
    lifecycle,
    build,
    callbacks,
    container,
    memoryTools,
    message,
    serialize,
  ] = await Promise.all([
    loadKeys(),
    loadInternal("context/dynamic-tool-lifecycle.js"),
    loadInternal("context/build-dynamic-tools.js"),
    loadInternal("tools/durable-callbacks.js"),
    loadInternal("context/container.js"),
    loadInternal("context/memory-tools.js"),
    loadInternal("protocol/message.js"),
    loadInternal("context/serialize.js"),
  ]);
  return {
    ...lifecycle,
    ...build,
    ...callbacks,
    ...container,
    ...memoryTools,
    ...message,
    ...serialize,
    keys,
  };
}

const sessionId = "session_rebind";
const user: Principal = {
  attributes: { workspaceId: "workspace_1" },
  authenticator: "eve",
  principalId: "user_1",
  principalType: "user",
};
const scheduledReport: Principal = {
  attributes: {},
  authenticator: "scheduled-result",
  principalId: "schedule_1",
  principalType: "service",
};

function durableTool(name: string, calls: string[]) {
  return defineTool({
    description: `The ${name} tool.`,
    inputSchema: {
      additionalProperties: false,
      properties: { query: { type: "string" } },
      type: "object",
    },
    execute: defineDurableCallback({
      callback: ({ tool }: { tool: string }, input: ToolInput) => {
        calls.push(tool);
        return { input, tool };
      },
      closure: { tool: name },
    }),
  });
}

/**
 * Two resolvers like Bro's: a memory provider whose tools exist only for a
 * person (eve marks it for rebinding) and an ordinary turn resolver.
 */
function createAgent(
  eve: EveInternals,
  calendarTools: readonly string[] = ["calendar-list-events"]
) {
  const calls: string[] = [];
  const memory = eve.createMemoryToolDynamicDefinition(
    {
      provider: {
        tools: ({ session }) =>
          session.auth.current?.principalType === "user"
            ? { save_memory: durableTool("profile__save_memory", calls) }
            : null,
      },
    },
    "profile"
  );
  const resolvers: Resolver[] = [
    {
      eventNames: ["turn.started"],
      events: memory.events,
      logicalPath: "memory/profile.ts",
      rebindMissingCallbacks: true,
      slug: "memory__profile",
    },
    {
      eventNames: ["turn.started"],
      events: {
        "turn.started": () =>
          Object.fromEntries(
            calendarTools.map((name) => [name, durableTool(name, calls)])
          ),
      },
      logicalPath: "tools/calendar.ts",
      slug: "calendar",
    },
  ];
  return { calls, resolvers };
}

function newContext(eve: EveInternals) {
  const ctx = new eve.ContextContainer();
  ctx.set(eve.keys.SessionIdKey, sessionId);
  ctx.set(eve.keys.AuthKey, user);
  ctx.set(eve.keys.TurnMemoryLocksKey, {
    profile: {
      namespaceKey: "profile",
      scope: { key: "workspace_1" },
      scopeKey: "workspace_1",
      slot: "profile",
      turn: { id: "turn_0", sequence: 0 },
    },
  });
  ctx.setVirtualContext(eve.keys.StaticModelReferenceKey, null);
  return ctx;
}

async function startTurn(
  eve: EveInternals,
  ctx: Context,
  resolvers: readonly Resolver[],
  sequence: number
) {
  await eve.contextStorage.run(ctx, () =>
    eve.dispatchDynamicToolEvent({
      ctx,
      event: eve.createTurnStartedEvent({
        sequence,
        turnId: `turn_${String(sequence)}`,
      }),
      messages: [],
      resolvers,
    })
  );
}

/** The next workflow step runs in a new process: context from storage, no callbacks. */
async function freshProcess(eve: EveInternals, ctx: Context) {
  const restored = await eve.deserializeContext(eve.serializeContext(ctx));
  restored.setVirtualContext(eve.keys.StaticModelReferenceKey, null);
  eve.clearDurableDynamicCallbacks(sessionId);
  return restored;
}

function rebind(
  eve: EveInternals,
  ctx: Context,
  resolvers: readonly Resolver[],
  turnInProgress: boolean
) {
  return eve.rebindMissingCompiledDynamicToolCallbacks({
    ctx,
    event: eve.createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
    messages: [],
    resolvers,
    turnInProgress,
  });
}

function callTool(
  eve: EveInternals,
  ctx: Context,
  name: string,
  current: Principal = user
) {
  const replayed = eve
    .buildDynamicTools(ctx)
    .find((tool) => tool.name === name);
  if (!replayed) throw new Error(`${name} is not in the tool set`);
  ctx.setVirtualContext(eve.keys.SessionKey, {
    auth: { current, initiator: user },
    sessionId,
    turn: { id: "turn_1", sequence: 1 },
  });
  return eve.contextStorage.run(ctx, () =>
    replayed.execute(
      { query: "today" },
      {
        abortSignal: new AbortController().signal,
        messages: [],
        toolCallId: "call_1",
      }
    )
  );
}

function toolNames(eve: EveInternals, ctx: Context) {
  return (ctx.get(eve.keys.TurnDynamicToolMetadataKey) ?? []).map(
    (tool) => tool.name
  );
}

describe("dynamic tools after a deploy", () => {
  it("keeps the session alive when the next message arrives in a fresh process", async () => {
    const eve = await loadEve();
    const { calls, resolvers } = createAgent(eve);
    const ctx = newContext(eve);
    await startTurn(eve, ctx, resolvers, 0);
    expect(toolNames(eve, ctx)).toEqual([
      "profile__save_memory",
      "calendar-list-events",
    ]);

    const next = await freshProcess(eve, ctx);
    // eve 0.62 threw "Dynamic tool callback rebind did not restore:
    // calendar-list-events" here: it rebinds only the memory resolver, yet
    // counted the ordinary turn tool as a failed rebind.
    await expect(rebind(eve, next, resolvers, false)).resolves.toBeUndefined();

    await startTurn(eve, next, resolvers, 1);
    await expect(callTool(eve, next, "calendar-list-events")).resolves.toEqual({
      input: { query: "today" },
      tool: "calendar-list-events",
    });
    await expect(callTool(eve, next, "profile__save_memory")).resolves.toEqual(
      expect.objectContaining({ tool: "profile__save_memory" })
    );
    expect(calls).toEqual(["calendar-list-events", "profile__save_memory"]);
  });

  it("rebuilds ordinary turn tools for a step in the middle of a turn", async () => {
    const eve = await loadEve();
    const { calls, resolvers } = createAgent(eve);
    const ctx = newContext(eve);
    await startTurn(eve, ctx, resolvers, 0);

    const next = await freshProcess(eve, ctx);
    await rebind(eve, next, resolvers, true);

    await expect(callTool(eve, next, "calendar-list-events")).resolves.toEqual({
      input: { query: "today" },
      tool: "calendar-list-events",
    });
    await expect(callTool(eve, next, "profile__save_memory")).resolves.toEqual(
      expect.objectContaining({ tool: "profile__save_memory" })
    );
    expect(calls).toEqual(["calendar-list-events", "profile__save_memory"]);
  });

  it("fails only the call when its tool can no longer be restored", async () => {
    const eve = await loadEve();
    const before = createAgent(eve, [
      "calendar-list-events",
      "calendar-old-search",
    ]);
    const ctx = newContext(eve);
    await startTurn(eve, ctx, before.resolvers, 0);

    // The deploy dropped a tool, and the step comes from a scheduled report,
    // for which the memory provider has no tools.
    const after = createAgent(eve);
    const next = await freshProcess(eve, ctx);
    next.set(eve.keys.AuthKey, scheduledReport);
    await expect(
      rebind(eve, next, after.resolvers, true)
    ).resolves.toBeUndefined();

    await expect(
      callTool(eve, next, "calendar-list-events", scheduledReport)
    ).resolves.toEqual(
      expect.objectContaining({ tool: "calendar-list-events" })
    );
    for (const gone of ["calendar-old-search", "profile__save_memory"]) {
      // oxlint-disable-next-line no-await-in-loop -- each call is checked on its own.
      await expect(callTool(eve, next, gone, scheduledReport)).rejects.toThrow(
        /did not run.*from the person's next message/u
      );
    }
    expect(after.calls).toEqual(["calendar-list-events"]);
  });
});
