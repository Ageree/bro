/**
 * Eve `MemoryScope.key` for a namespace + scalar scope.
 *
 * A hand copy of `createMemoryLock` in
 * `node_modules/eve/dist/src/shared/memory-state.js` — private, not exported
 * from any eve entry point. It is still needed after the recall slots were
 * unified on one search pass: that pass is keyed on the person's E.164, and
 * the conversation half has to address the Supermemory container eve's own
 * plugin writes to, which is named after this digest. Neither slot can supply
 * it — the archive slot's `scope.key` is for its own namespace, and the
 * webhook prefetch runs with no eve context at all.
 *
 * `scripts/archive-check.ts` asserts this digest against the real
 * `createMemoryLock`, so the day eve changes the encoding the check fails
 * instead of recall silently searching an empty container.
 */
import { createHash } from "node:crypto";

export const CONVERSATION_MEMORY_NAMESPACE = "bro-recall-v1";

function uint32(n: number): Buffer {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(n);
  return buf;
}

function lengthPrefix(buf: Buffer): Buffer {
  return Buffer.concat([uint32(buf.byteLength), buf]);
}

function encodeScalar(kind: string, value: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${kind}-v1\0`),
    lengthPrefix(Buffer.from(value, "utf8")),
  ]);
}

function digest(prefix: string, input: Buffer): string {
  return `${prefix}${createHash("sha256").update(input).digest("base64url")}`;
}

export function eveMemoryScopeKey(namespace: string, scopeValue: string): string {
  if (!namespace.trim() || !scopeValue.trim()) {
    throw new Error("namespace and scopeValue must be non-empty");
  }
  const ns = encodeScalar("namespace", namespace);
  const scope = encodeScalar("scope-scalar", scopeValue);
  const nsKey = digest("memns1_", ns);
  const scopePart = digest("memscope1_", scope);
  const composite = Buffer.concat([
    Buffer.from("eve-memory-composite-v1\0"),
    lengthPrefix(Buffer.from(nsKey)),
    lengthPrefix(Buffer.from(scopePart)),
  ]);
  return digest("memscope1_", composite);
}

export function conversationScopeKey(scopeValue: string): string {
  return eveMemoryScopeKey(CONVERSATION_MEMORY_NAMESPACE, scopeValue);
}
