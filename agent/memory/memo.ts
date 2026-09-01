import { defineMemory } from "eve/memory";
import { convexMemory } from "../lib/convex-memory.ts";
import { resolveMemoryScope } from "../lib/memory-policy.ts";

/**
 * Curated long-term memory: one Convex line store per person. Recalled every
 * turn; the model maintains it through memo__remember / search / forget.
 */
export default defineMemory({
  namespace: "bro-memo-v1",
  description: "Curated long-term memory for this person.",
  provider: convexMemory(),
  scope: (ctx) =>
    resolveMemoryScope(ctx.session.auth, process.env.NODE_ENV === "production"),
});
