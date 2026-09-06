import { defineTool } from "eve/tools";
import { z } from "zod";
import { cabinetLoginFor } from "../lib/convex";
import { tenantId } from "../lib/tenant";

function cabinetBase(): string {
  // Only the static cabinet host: BRO_PAY_BASE is the Convex HTTP origin and
  // has no /cabinet.html.
  const raw = process.env.BRO_CABINET_BASE?.trim() || "";
  if (!raw) {
    throw new Error("BRO_CABINET_BASE is not set — cannot build a cabinet login link");
  }
  return raw.replace(/\/$/, "");
}

export default defineTool({
  description:
    "Send the human a one-tap link into their bro cabinet (subscription, limits, vault, browser profile). Use whenever they ask how to log in or open the cabinet. Never ask them for a handle or a code.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    // Resolve the host before minting a challenge, so a misconfigured env
    // never burns the 45-second cooldown on a link nobody receives.
    const base = cabinetBase();
    const phone = tenantId(ctx);
    const result = await cabinetLoginFor(phone);
    if (!result.ok) {
      if (result.code === "cooldown") {
        return {
          message:
            "Ссылку уже отправлял только что — посмотри чуть выше. Новую смогу прислать через минуту.",
        };
      }
      return {
        message: "Кабинет появится после первого сообщения Bro в iMessage.",
      };
    }
    return {
      url: `${base}/cabinet.html#login=${result.handle}.${result.code}`,
      message: "Нажми ссылку — откроется кабинет. Ссылка действует 10 минут.",
    };
  },
});
