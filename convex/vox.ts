import { v } from "convex/values";
import { action } from "./_generated/server";
import { assertSecret } from "./secret";

const APP_ID = "59499143";
const RULE_ID = "9331615";

export const startCallback = action({
  args: {
    secret: v.string(),
    destE164: v.string(),
    inkboxE164: v.string(),
    cliE164: v.string(),
  },
  returns: v.union(
    v.object({ mediaSessionId: v.string() }),
    v.object({ error: v.string() }),
  ),
  handler: async (_ctx, args) => {
    assertSecret(args.secret);
    const account =
      process.env.VOXIMPLANT_ACCOUNT_ID ?? process.env.VOX_ACCOUNT_ID ?? "";
    const key =
      process.env.VOXIMPLANT_API_KEY ?? process.env.VOX_API_KEY ?? "";
    if (!account || !key) {
      return { error: "Voximplant API keys missing on Convex" };
    }
    const app = process.env.VOXIMPLANT_APP_ID ?? APP_ID;
    const rule = process.env.VOXIMPLANT_RULE_ID ?? RULE_ID;
    const qs = new URLSearchParams({
      account_id: account,
      api_key: key,
      application_id: app,
      rule_id: rule,
      script_custom_data: JSON.stringify({
        dest: args.destE164,
        inkbox: args.inkboxE164,
        cli: args.cliE164,
      }),
    });
    const res = await fetch(
      `https://api.voximplant.com/platform_api/StartScenarios?${qs}`,
      { method: "GET", signal: AbortSignal.timeout(20_000) },
    );
    const json = (await res.json()) as {
      result?: unknown;
      call_session_history_id?: unknown;
      error?: { msg?: unknown };
    };
    if (!res.ok || json.result !== 1) {
      const msg =
        typeof json.error?.msg === "string"
          ? json.error.msg
          : `vox start ${res.status}`;
      return { error: msg };
    }
    return { mediaSessionId: String(json.call_session_history_id ?? "ok") };
  },
});
