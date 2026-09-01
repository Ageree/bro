import supermemory from "@supermemory/eve";
import { defineMemory } from "eve/memory";
import { resolveMemoryScope, resolveRecallBackend } from "../lib/memory-policy.ts";

/**
 * Automatic conversation memory via Supermemory (paid, zero-config for users):
 * completed turns are captured per person, relevant context is recalled before
 * each turn, and the model gets recall__search / remember / forget tools.
 *
 * Without SUPERMEMORY_API_KEY the scope resolves to null, which disables this
 * slot entirely; the curated `memo` slot keeps working on Convex alone.
 */
export default defineMemory({
  namespace: "bro-recall-v1",
  description: "Automatic memory of past conversations with this person.",
  provider: supermemory({
    // Lazy: only read when the slot is active, so a missing key cannot crash boot.
    apiKey: () => {
      const backend = resolveRecallBackend(process.env);
      if (backend.kind !== "supermemory") {
        throw new Error("SUPERMEMORY_API_KEY missing");
      }
      return backend.apiKey;
    },
  }),
  scope: (ctx) =>
    resolveRecallBackend(process.env).kind === "supermemory"
      ? resolveMemoryScope(ctx.session.auth, process.env.NODE_ENV === "production")
      : null,
});
