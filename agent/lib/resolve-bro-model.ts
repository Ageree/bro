import { isGroupTurn } from "./group-guard.ts";
import {
  broModel,
  resolveBroModel,
  type BroModelOpts,
  type ChatgptModelStatus,
} from "./model.ts";
import { chatgptQuarantine, chatgptStatus, chatgptToken } from "./convex.ts";
import { tenantId } from "./tenant.ts";
import {
  isCodexFallbackError,
  type CodexTokenBroker,
} from "./codex-model.ts";

const SHARED = new Set(["local-dev", "unknown", "default", "eve:app"]);

type TurnCtx = Parameters<typeof tenantId>[0] & Parameters<typeof isGroupTurn>[0];

function convexBroker(phoneE164: string): CodexTokenBroker {
  return {
    async getToken() {
      const row = await chatgptToken(phoneE164);
      if (row.status !== "connected" || !row.accessToken) {
        throw new Error("chatgpt token unavailable");
      }
      return {
        accessToken: row.accessToken,
        ...(row.accountId ? { accountId: row.accountId } : {}),
      };
    },
  };
}

export async function resolveBroModelForTurn(
  ctx: TurnCtx,
  opts?: BroModelOpts,
) {
  const isGroup = isGroupTurn(ctx);
  const phone = tenantId(ctx);
  if (isGroup || SHARED.has(phone)) {
    return broModel(opts);
  }
  let chatgpt: ChatgptModelStatus = "none";
  try {
    chatgpt = (await chatgptStatus(phone)).status;
  } catch {
    return broModel(opts);
  }
  if (chatgpt !== "connected") {
    return broModel(opts);
  }
  return resolveBroModel(
    { isGroup: false, chatgpt },
    {
      ...opts,
      broker: convexBroker(phone),
      onFail: (err) => {
        if (!isCodexFallbackError(err)) return;
        const message = err instanceof Error ? err.message : "codex failed";
        void chatgptQuarantine(phone, message).catch(() => undefined);
      },
    },
  );
}
