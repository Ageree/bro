/**
 * Moved to `convex/lib/orderPolicy.ts` so the Convex follow-through can parse
 * a background purchase with the very same parser (Convex bundles its own
 * code and never imports from agent/). Re-exported here: every existing
 * import still works.
 */
export * from "../../convex/lib/orderPolicy.ts";
