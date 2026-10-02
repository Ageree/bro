import { createHash } from "node:crypto";
import {
  defaultNamespace,
  type MemoryNamespaceContext,
  type MemoryOperationContext,
} from "eve/memory";
import { z } from "zod";
import { env } from "@shared/environment";

/**
 * The namespaces of the profile and workstreams slots, pinned to what eve's
 * default (`defaultNamespace` in `eve/memory`) gave them on Vercel
 * production, where everything saved before the move to Cloud.ru lives. The
 * default hashes the build's checkout path off Vercel, so on the VM it hid
 * every earlier memory and moved again with each build path.
 */
const pinnedMemoryNamespaces = {
  profile:
    '["eve-memory-default-namespace-v1","vercel","prj_EBJG5tSUNetiNjkAB00iwwMjALYT","production",null,"__root__","profile"]',
  workstreams:
    '["eve-memory-default-namespace-v1","vercel","prj_EBJG5tSUNetiNjkAB00iwwMjALYT","production",null,"__root__","workstreams"]',
} as const;

type PinnedSlot = keyof typeof pinnedMemoryNamespaces;

/**
 * A slot's `namespace`: the pinned one, except on a Vercel preview, which
 * shares the production database and keeps eve's own per-branch default, so
 * an unmerged branch neither reads nor writes people's memory.
 */
export function memoryNamespace(slot: PinnedSlot) {
  return (context: MemoryNamespaceContext) =>
    env.VERCEL_ENV === "preview"
      ? defaultNamespace(context)
      : pinnedMemoryNamespaces[slot];
}

/**
 * Every checkout the Cloud.ru VM's releases were built from between the move
 * (02.10) and the pin, oldest first: eve bakes the build path into the
 * release, and its local default namespace hashes it, so each of these gave
 * the slots another scope key. Read from the releases in Object Storage.
 */
const cutoverAppRoots = [
  "/tmp/claude-0/-home-user-bro/099d1748-6700-5603-bdce-48a80a3e9def/scratchpad/wt-server",
  "/tmp/claude-0/-home-user-bro/099d1748-6700-5603-bdce-48a80a3e9def/scratchpad/wt-stand",
  "/tmp/claude-0/-home-user-bro/099d1748-6700-5603-bdce-48a80a3e9def/scratchpad/wt-ops",
  "/tmp/claude-0/-home-user-bro/099d1748-6700-5603-bdce-48a80a3e9def/scratchpad/wt-rel",
  "/home/user/bro",
];

/**
 * The scope keys the VM gave a slot between the move and the pin, in release
 * order: eve's local default namespace for each of `cutoverAppRoots`. What
 * was saved there is adopted into the pinned scope.
 */
function cutoverScopeKeys(slot: PinnedSlot, value: string) {
  return cutoverAppRoots.map((appRoot) =>
    memoryScopeKey(
      JSON.stringify([
        "eve-memory-default-namespace-v1",
        "local",
        createHash("sha256").update(appRoot).digest("base64url"),
        "__root__",
        slot,
      ]),
      value
    )
  );
}

/**
 * Adopts into the pinned scope what the VM saved under the slot's cutover
 * keys, with `adopt` (`adoptMemoryRecords`, `adoptWorkstreams`). Best effort:
 * eve fails the whole turn when any slot's recall rejects, and a failure that
 * comes from the data would recur on every turn, so it is logged and the
 * records wait for a later turn. Nothing happens under another namespace.
 */
export async function adoptCutoverMemory(
  context: Pick<MemoryOperationContext, "abortSignal" | "memory">,
  slot: PinnedSlot,
  workspaceId: string,
  adopt: (fromKeys: readonly string[], toKey: string) => Promise<number>
) {
  const { scope } = context.memory;
  if (scope.namespace !== pinnedMemoryNamespaces[slot]) return;
  try {
    await adopt(cutoverScopeKeys(slot, workspaceId), scope.key);
  } catch (error) {
    context.abortSignal.throwIfAborted();
    // Not the message: a failed query's carries its parameters, memory text.
    const failure = failureSchema.safeParse(error).data;
    console.warn("[memory] adopting the VM's memory failed", {
      code: failure?.cause?.code,
      error: failure?.name,
      slot,
      workspaceId,
    });
  }
  context.abortSignal.throwIfAborted();
}

/** What of a failed adoption is safe to log: the error's kind and SQLSTATE. */
const failureSchema = z.object({
  cause: z.object({ code: z.string() }).optional().catch(undefined),
  name: z.string(),
});

/**
 * The scope key eve 0.62 derives for a namespace and a single-string scope
 * value, as both slots resolve (`createMemoryLock` in
 * `eve/dist/src/shared/memory-state.js`, which the package does not export).
 * A test holds the adopted keys to eve's own function.
 */
function memoryScopeKey(namespace: string, value: string) {
  const namespaceKey = digest("memns1_", encodeScalar("namespace", namespace));
  const scopeKey = digest("memscope1_", encodeScalar("scope-scalar", value));
  return digest(
    "memscope1_",
    Buffer.concat([
      Buffer.from("eve-memory-composite-v1\0"),
      lengthPrefix(Buffer.from(namespaceKey)),
      lengthPrefix(Buffer.from(scopeKey)),
    ])
  );
}

function encodeScalar(label: string, value: string) {
  return Buffer.concat([
    Buffer.from(`${label}-v1\0`),
    lengthPrefix(Buffer.from(value, "utf8")),
  ]);
}

function lengthPrefix(bytes: Buffer) {
  return Buffer.concat([uint32(bytes.byteLength), bytes]);
}

function uint32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function digest(prefix: string, bytes: Buffer) {
  return `${prefix}${createHash("sha256").update(bytes).digest("base64url")}`;
}
