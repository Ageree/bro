import { generateText, type ModelMessage, tool, type ToolCallPart } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
import { browserTaskApproval } from "@agent/tools/browser_task";
import { spendLimitApproval } from "@agent/tools/spend_limit";

/**
 * eve's memory recall helpers are internal, so the test loads the patched
 * module by path (`patches/eve@0.62.0.patch`).
 */
interface MemoryState {
  applyMemoryRecallBatches: (input: {
    batches: readonly {
      lock: MemoryLock;
      messages: readonly { content: string; itemKey?: string }[];
      operationId: string;
    }[];
    history: readonly ModelMessage[];
    state: object;
  }) => { history: ModelMessage[]; state: object };
  projectMemoryHistory: (input: {
    locks: Record<string, MemoryLock>;
    messages: readonly ModelMessage[];
  }) => ModelMessage[];
}

interface MemoryLock {
  namespaceKey: string;
  scopeKey: string;
  slot: string;
}

async function loadMemoryState() {
  // SAFETY: the module's exports are declared by the interface above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- eve does not export this internal module's types.
  return (await import(
    /* @vite-ignore */ new URL(
      "../../node_modules/eve/dist/src/shared/memory-state.js",
      import.meta.url
    ).href
  )) as MemoryState;
}

const lock = {
  namespaceKey: "profile",
  scopeKey: "workspace",
  slot: "profile",
};

function recall(operationId: string, content: string) {
  return {
    batches: [
      { lock, messages: [{ content, itemKey: "profile" }], operationId },
    ],
  };
}

function approvalTurn(
  toolName: string,
  input: ToolCallPart["input"]
): ModelMessage[] {
  return [
    {
      content: [
        { input, toolCallId: "call_1", toolName, type: "tool-call" },
        {
          approvalId: "approval_1",
          toolCallId: "call_1",
          type: "tool-approval-request",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          approvalId: "approval_1",
          approved: true,
          type: "tool-approval-response",
        },
      ],
      role: "tool",
    },
  ];
}

// The AI SDK re-checks each approved call with its policy before running it,
// so the gated tools' real policies must keep an approved call approved.
const gatedCalls = [
  {
    input: { summary: "Ужин с Сэм" },
    policy: (): ApprovalStatus => "user-approval",
    toolName: "calendar-create-event",
  },
  {
    input: { action: "continue", allowPayment: true, runId: "run_1" },
    policy: () =>
      browserTaskApproval(
        {
          action: "continue",
          allowPayment: true,
          runId: "run_1",
          submission: {
            forWhom: "Алиса",
            personalData: ["имя", "адрес"],
            what: "заказ корма для кота",
            where: "shop.example",
          },
        },
        {
          session: {
            auth: {
              current: {
                attributes: {},
                authenticator: "photon-imessage",
                issuer: "photon",
                principalId: "better-auth:alice",
                principalType: "user",
              },
              initiator: null,
            },
          },
        }
      ),
    toolName: "browser_task",
  },
  {
    input: { action: "set", limitRub: 5000 },
    policy: () =>
      spendLimitApproval({ action: "set", limitRub: 5000 }, undefined),
    toolName: "spend_limit",
  },
];

describe("an approved tool call after a memory recall", () => {
  it.for(gatedCalls)(
    "runs $toolName once when the recalled memory changed while the approval waited",
    async ({ input, policy, toolName }) => {
      const { applyMemoryRecallBatches, projectMemoryHistory } =
        await loadMemoryState();
      const firstTurn = applyMemoryRecallBatches({
        ...recall("turn_0", "profile v1"),
        history: [{ content: "Поставь ужин с Сэм на 19:00", role: "user" }],
        state: {},
      });
      // Another conversation saved a memory before the person approved, so
      // the approval turn recalls a different profile.
      const approvedTurn = applyMemoryRecallBatches({
        ...recall("turn_1", "profile v2"),
        history: [...firstTurn.history, ...approvalTurn(toolName, input)],
        state: firstTurn.state,
      });
      const messages = projectMemoryHistory({
        locks: { [lock.slot]: lock },
        messages: approvedTurn.history,
      });

      const execute = vi.fn<() => { created: boolean }>(() => ({
        created: true,
      }));
      const prompts: unknown[] = [];
      await generateText({
        messages,
        model: new MockLanguageModelV4({
          doGenerate: async (options) => {
            prompts.push(options.prompt);
            return {
              content: [{ text: "Поставил", type: "text" }],
              finishReason: { raw: "stop", unified: "stop" },
              usage: {
                inputTokens: {
                  cacheRead: 0,
                  cacheWrite: 0,
                  noCache: 1,
                  total: 1,
                },
                outputTokens: { reasoning: 0, text: 1, total: 1 },
              },
              warnings: [],
            };
          },
        }),
        // eve hands the policy's answer to the AI SDK the same way.
        toolApproval: () => {
          const status = policy();
          if (status === true) return "user-approval";
          if (status === false) return "not-applicable";
          return status;
        },
        tools: {
          [toolName]: tool({ execute, inputSchema: z.looseObject({}) }),
        },
      });

      expect(execute).toHaveBeenCalledOnce();
      expect(JSON.stringify(prompts)).toContain('"type":"tool-result"');
      expect(JSON.stringify(messages)).toContain("profile v2");
      expect(messages.at(-1)?.role).toBe("tool");
    }
  );
});
