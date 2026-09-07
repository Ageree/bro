import { defineTool } from "eve/tools";
import {
  createVaultSetupUrl,
  vaultSetupRequestSchema,
} from "../../convex/lib/vaultPayload.ts";
import { groupPersonalBlock } from "../lib/group-guard";

function cabinetBase(): string {
  const raw =
    process.env.BRO_CABINET_BASE?.trim() || process.env.BRO_PAY_BASE?.trim() || "";
  if (!raw) {
    throw new Error(
      "BRO_CABINET_BASE (or BRO_PAY_BASE) is not set — cannot build a vault setup link",
    );
  }
  return raw.replace(/\/$/, "");
}

export default defineTool({
  description:
    "Cabinet link to save payment, address, or contact. Site logins use profile_setup. Never put a card number, CVV, or secret in the arguments — they type those on the page.",
  inputSchema: vaultSetupRequestSchema,
  async execute(request, ctx) {
    const blocked = groupPersonalBlock(ctx);
    if (blocked) return { error: blocked };
    const url = createVaultSetupUrl(cabinetBase(), request);
    return {
      url,
      message:
        "Открой ссылку, войди в кабинет и введи данные там. Пароль и номер карты в чат не пиши.",
    };
  },
});
