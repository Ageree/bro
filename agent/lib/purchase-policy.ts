/**
 * Moved to `convex/lib/purchasePolicy.ts` so the Convex follow-through can
 * apply the same purchase rules (Convex bundles its own code and never
 * imports from agent/). Re-exported here: every existing import still works.
 */
export * from "../../convex/lib/purchasePolicy.ts";
