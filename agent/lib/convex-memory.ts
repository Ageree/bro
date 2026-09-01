import {
  defineMemoryProvider,
  type MemoryOperationContext,
  type MemoryProvider,
  type MemoryRecallResult,
} from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { forgetLines, noteLine, searchLines, wakeLines } from "./convex.ts";
import { formatMemoryRecall, scopePhone } from "./memory-policy.ts";

const RECALL_ID = "bro-memories";

/**
 * A Convex outage must degrade the turn, not fail it: a throwing turn-start
 * recall would take Bro down entirely.
 */
async function recall(context: MemoryOperationContext): Promise<MemoryRecallResult> {
  let content: string;
  try {
    content = formatMemoryRecall(await wakeLines(scopePhone(context.memory.scope.value)));
  } catch (err) {
    content = `Memory store unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { messages: [{ id: RECALL_ID, content }] };
}

/** Durable one-line facts per person, stored in the Convex `memories` table. */
export function convexMemory(): MemoryProvider {
  return defineMemoryProvider({
    recall: {
      "turn.started": recall,
      "compaction.completed": recall,
    },
    async tools(context) {
      const phone = scopePhone(context.memory.scope.value);
      return {
        remember: defineTool({
          description:
            "Save one lasting fact (one line, ≤280 chars): size, address, ПВЗ, taste, a decision, a completed order, a login that worked or failed. Never secrets or one-time codes.",
          inputSchema: z.object({ line: z.string().min(1).max(280) }),
          execute({ line }) {
            return noteLine(phone, line);
          },
        }),
        search: defineTool({
          description:
            "Search this person's memory lines (substring, case-insensitive).",
          inputSchema: z.object({ contains: z.string().min(1) }),
          async execute({ contains }) {
            const rows = await searchLines(phone, contains);
            return rows.length ? rows.join("\n") : "no matches";
          },
        }),
        forget: defineTool({
          description: "Delete memory lines that contain this substring.",
          inputSchema: z.object({ contains: z.string().min(1) }),
          execute({ contains }) {
            return forgetLines(phone, contains);
          },
        }),
      };
    },
  });
}
