import { defineTool } from "eve/tools";
import { z } from "zod";
import { cabinetLoginFor } from "../lib/convex";
import { tenantId } from "../lib/tenant";

function cabinetBase(): string {
  const raw =
    process.env.BRO_CABINET_BASE?.trim() || process.env.BRO_PAY_BASE?.trim() || "";
  if (!raw) {
    throw new Error(
      "BRO_CABINET_BASE (or BRO_PAY_BASE) is not set — cannot build a cabinet login link",
    );
  }
  return raw.replace(/\/$/, "");
}

export default defineTool({
  description:
    "Send the human a one-tap link into their bro cabinet (subscription, limits, vault, browser profile). Use whenever they ask how to log in or open the cabinet. Never ask them for a handle or a code.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const phone = tenantId(ctx);
    const result = await cabinetLoginFor(phone);
    if (!result.ok) {
      if (result.code === "cooldown") {
        return {
          message:
            "Ссылку уже отправлял минуту назад — посмотри чуть выше. Через минуту могу прислать новую.",
        };
      }
      return {
        message: "Кабинет появится после первого сообщения Bro в iMessage.",
      };
    }
    const base = cabinetBase();
    return {
      url: `${base}/cabinet.html#login=${result.handle}.${result.code}`,
      message: "Нажми ссылку — откроется кабинет. Ссылка действует 10 минут.",
    };
  },
});
