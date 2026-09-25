import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { defineDurableCallback, defineTool } from "eve/tools";

/**
 * A photo in the conversation used to take Bro's memory tools away. eve stages
 * an inbound attachment in the sandbox and keeps an `eve-sandbox:` URL in the
 * history, and its memory provider tools captured the whole resolve context,
 * history and turn input included, into their durable closure as JSON: every
 * turn that still had the photo in its history lost `profile__*`,
 * `personal_info__update` and `workstreams__*` with «Expected a
 * JSON-serializable value.». eve's helpers are internal, so the test loads the
 * patched modules by path (`patches/eve@0.62.0.patch`) and declares only the
 * shapes it uses.
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
  readonly turn: {
    readonly id: string;
    readonly input: readonly ModelMessage[];
    readonly sequence: number;
  };
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

interface MemoryToolsContext {
  readonly messages: readonly ModelMessage[];
  readonly session: {
    readonly auth: { readonly current: Principal | null };
  };
  readonly turn: { readonly input: readonly ModelMessage[] };
}

type Tools = Readonly<
  Record<string, ReturnType<typeof memoryTool | typeof calendarTool>>
>;
type TurnResolver = (
  event: TurnEvent,
  context: MemoryToolsContext
) => Tools | null | Promise<Tools | null>;

interface Resolver {
  readonly eventNames: readonly string[];
  readonly events: Readonly<Record<string, TurnResolver>>;
  readonly logicalPath: string;
  readonly rebindMissingCallbacks?: boolean;
  readonly slug: string;
}

interface ToolCallOptions {
  readonly abortSignal: AbortSignal;
  readonly messages: readonly never[];
  readonly toolCallId: string;
}

interface ReplayedTool {
  readonly execute: (
    input: { readonly fact: string },
    options: ToolCallOptions
  ) => Promise<{ readonly saved: string }>;
  readonly name: string;
}

interface ToolEventInput {
  readonly ctx: Context;
  readonly event: TurnEvent;
  readonly messages: readonly ModelMessage[];
  readonly resolvers: readonly Resolver[];
}

/** The sandbox calls eve makes while staging an attachment. */
interface StagingSandbox {
  resolvePath(path: string): string;
  writeBinaryFile(input: { content: Uint8Array; path: string }): Promise<void>;
}

type UserParts = Exclude<
  Extract<ModelMessage, { role: "user" }>["content"],
  string
>;

interface EveInternals {
  buildDynamicTools(ctx: Context): ReplayedTool[];
  clearDurableDynamicCallbacks(sessionId: string): void;
  ContextContainer: new () => Context;
  contextStorage: { run<T>(ctx: Context, run: () => T): T };
  createMemoryToolDynamicDefinition(
    definition: {
      provider: { tools(context: MemoryToolsContext): Tools | null };
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
  stageAttachmentsForAdapter(
    content: UserParts,
    sandbox: StagingSandbox,
    adapter: Readonly<Record<string, never>>
  ): Promise<UserParts>;
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
    staging,
  ] = await Promise.all([
    loadKeys(),
    loadInternal("context/dynamic-tool-lifecycle.js"),
    loadInternal("context/build-dynamic-tools.js"),
    loadInternal("tools/durable-callbacks.js"),
    loadInternal("context/container.js"),
    loadInternal("context/memory-tools.js"),
    loadInternal("protocol/message.js"),
    loadInternal("context/serialize.js"),
    loadInternal("harness/attachment-staging.js"),
  ]);
  return {
    ...lifecycle,
    ...build,
    ...callbacks,
    ...container,
    ...memoryTools,
    ...message,
    ...serialize,
    ...staging,
    keys,
  };
}

const sessionId = "session_photos";
const user: Principal = {
  attributes: { workspaceId: "workspace_1" },
  authenticator: "authjs",
  principalId: "user_1",
  principalType: "user",
};
const memorySlots = ["personal_info", "profile", "workstreams"] as const;
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBase64 = Buffer.from(png).toString("base64");

/** The eve web chat keeps a data URL; Telegram and iMessage send bare base64. */
const inboundForms = [
  ["the web chat", `data:image/png;base64,${pngBase64}`],
  ["Telegram and iMessage", pngBase64],
] as const;

function inboundPhotos(data: string): UserParts {
  return [
    { text: "вот показания", type: "text" },
    ...["electricity", "hot-water", "cold-water"].map((meter) => ({
      data,
      filename: `${meter}-meter.png`,
      mediaType: "image/png",
      type: "file" as const,
    })),
  ];
}

/** Stages the photos the way eve does before the first model step. */
async function stagedMessage(eve: EveInternals, data: string) {
  const written: string[] = [];
  const content = await eve.stageAttachmentsForAdapter(
    inboundPhotos(data),
    {
      resolvePath: (path) => path,
      async writeBinaryFile({ path }) {
        written.push(path);
      },
    },
    {}
  );
  return { message: { content, role: "user" as const }, written };
}

/** A memory provider tool as Bro's providers write it: a plain `execute`. */
function memoryTool(slot: string, saved: string[]) {
  return defineTool({
    description: `Save to ${slot}.`,
    inputSchema: {
      additionalProperties: false,
      properties: { fact: { type: "string" } },
      type: "object",
    },
    execute: ({ fact }: { fact: string }) => {
      saved.push(`${slot}: ${fact}`);
      return { saved: fact };
    },
  });
}

function calendarTool() {
  return defineTool({
    description: "List events.",
    inputSchema: { type: "object" },
    execute: defineDurableCallback({
      callback: () => ({ events: [] }),
      closure: {},
    }),
  });
}

/** Bro's three memory providers and one ordinary turn resolver. */
function createAgent(eve: EveInternals) {
  const saved: string[] = [];
  const memoryResolvers = memorySlots.map((slot): Resolver => {
    const memory = eve.createMemoryToolDynamicDefinition(
      {
        provider: {
          tools: ({ session }) =>
            session.auth.current?.principalType === "user"
              ? { save: memoryTool(slot, saved) }
              : null,
        },
      },
      slot
    );
    return {
      eventNames: ["turn.started"],
      events: memory.events,
      logicalPath: `memory/${slot}.ts`,
      rebindMissingCallbacks: true,
      slug: `memory__${slot}`,
    };
  });
  const ordinary: Resolver = {
    eventNames: ["turn.started"],
    events: {
      "turn.started": () => ({ "calendar-list-events": calendarTool() }),
    },
    logicalPath: "tools/calendar.ts",
    slug: "calendar",
  };
  return { resolvers: [...memoryResolvers, ordinary], saved };
}

function turnEvent(eve: EveInternals, sequence: number) {
  return eve.createTurnStartedEvent({
    sequence,
    turnId: `turn_${String(sequence)}`,
  });
}

/** What eve holds when a turn starts: the memory locks with the turn input. */
function withTurnLocks(
  eve: EveInternals,
  ctx: Context,
  sequence: number,
  input: readonly ModelMessage[]
) {
  ctx.set(
    eve.keys.TurnMemoryLocksKey,
    Object.fromEntries(
      memorySlots.map((slot) => [
        slot,
        {
          namespaceKey: slot,
          scope: { key: "workspace_1" },
          scopeKey: "workspace_1",
          slot,
          turn: { id: `turn_${String(sequence)}`, input, sequence },
        },
      ])
    )
  );
}

function newContext(eve: EveInternals) {
  const ctx = new eve.ContextContainer();
  ctx.set(eve.keys.SessionIdKey, sessionId);
  ctx.set(eve.keys.AuthKey, user);
  ctx.setVirtualContext(eve.keys.StaticModelReferenceKey, null);
  return ctx;
}

async function startTurn(
  eve: EveInternals,
  ctx: Context,
  resolvers: readonly Resolver[],
  sequence: number,
  messages: readonly ModelMessage[],
  input: readonly ModelMessage[]
) {
  withTurnLocks(eve, ctx, sequence, input);
  await eve.contextStorage.run(ctx, () =>
    eve.dispatchDynamicToolEvent({
      ctx,
      event: turnEvent(eve, sequence),
      messages,
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

function turnTools(eve: EveInternals, ctx: Context) {
  return ctx.get(eve.keys.TurnDynamicToolMetadataKey) ?? [];
}

function callTool(eve: EveInternals, ctx: Context, name: string, fact: string) {
  const replayed = eve
    .buildDynamicTools(ctx)
    .find((tool) => tool.name === name);
  if (!replayed) throw new Error(`${name} is not in the tool set`);
  ctx.setVirtualContext(eve.keys.SessionKey, {
    auth: { current: user, initiator: user },
    sessionId,
    turn: { id: "turn_1", sequence: 1 },
  });
  return eve.contextStorage.run(ctx, () =>
    replayed.execute(
      { fact },
      {
        abortSignal: new AbortController().signal,
        messages: [],
        toolCallId: "call_1",
      }
    )
  );
}

const memoryTools = [
  "personal_info__save",
  "profile__save",
  "workstreams__save",
];

describe("memory tools with photos in the conversation", () => {
  it.each(inboundForms)(
    "eve stages a photo from %s as a sandbox URL",
    async (_channel, data) => {
      const eve = await loadEve();
      const { message, written } = await stagedMessage(eve, data);

      expect(written).toHaveLength(3);
      for (const part of message.content.slice(1)) {
        expect(part).toMatchObject({ mediaType: "image/png", type: "file" });
        const staged = part.type === "file" ? part.data : undefined;
        expect(staged).toBeInstanceOf(URL);
        expect(staged instanceof URL && staged.href).toMatch(
          /^eve-sandbox:\?path=%2Fworkspace%2Fattachments%2F/u
        );
      }
    }
  );

  it.each(inboundForms)(
    "keeps every memory tool on the turn a photo from %s arrives",
    async (_channel, data) => {
      const eve = await loadEve();
      const { resolvers } = createAgent(eve);
      const { message } = await stagedMessage(eve, data);
      const ctx = newContext(eve);

      // eve 0.62 logged «Dynamic tool resolver (turn.started) failed —
      // skipping its complete result. { error: 'Expected a JSON-serializable
      // value.' }» once per memory slot here, and the turn went on without
      // them.
      await startTurn(eve, ctx, resolvers, 0, [message], [message]);

      expect(turnTools(eve, ctx).map((tool) => tool.name)).toEqual([
        ...memoryTools,
        "calendar-list-events",
      ]);
      // The closure carries no history: neither the photos nor the words.
      const persisted = JSON.stringify(turnTools(eve, ctx));
      expect(persisted).not.toContain("eve-sandbox");
      expect(persisted).not.toContain("вот показания");
    }
  );

  it("keeps them on later turns of the session and runs them after a deploy", async () => {
    const eve = await loadEve();
    const { resolvers, saved } = createAgent(eve);
    const { message } = await stagedMessage(eve, inboundForms[0][1]);
    const ctx = newContext(eve);
    await startTurn(eve, ctx, resolvers, 0, [message], [message]);

    // The photo stays in the history of every later turn.
    const next = await freshProcess(eve, ctx);
    const reply: ModelMessage = { content: "Принял.", role: "assistant" };
    const later: ModelMessage = {
      content: "запомни: счётчики сдаю 20-го",
      role: "user",
    };
    const history = [message, reply, later];
    await eve.contextStorage.run(next, () =>
      eve.rebindMissingCompiledDynamicToolCallbacks({
        ctx: next,
        event: turnEvent(eve, 1),
        messages: history,
        resolvers,
      })
    );
    await startTurn(eve, next, resolvers, 1, history, [later]);
    expect(turnTools(eve, next).map((tool) => tool.name)).toEqual([
      ...memoryTools,
      "calendar-list-events",
    ]);

    const step = await freshProcess(eve, next);
    await eve.contextStorage.run(step, () =>
      eve.rebindMissingCompiledDynamicToolCallbacks({
        ctx: step,
        event: turnEvent(eve, 1),
        messages: history,
        resolvers,
        turnInProgress: true,
      })
    );
    await expect(
      callTool(eve, step, "profile__save", "счётчики сдаёт 20-го")
    ).resolves.toEqual({ saved: "счётчики сдаёт 20-го" });
    expect(saved).toEqual(["profile: счётчики сдаёт 20-го"]);
  });
});
