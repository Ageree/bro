import { defineTool } from "eve/tools";
import {
  createVaultSetupUrl,
  vaultSetupRequestSchema,
} from "../../convex/lib/vaultPayload.ts";
import { instinctBlocked } from "../lib/instinct-guard.ts";
import { turnAttributes } from "../lib/turn-attrs";

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
    "Cabinet link so they add or edit a payment, address, contact, or site login on brobro.tech. Kind login: they type the password on the site, never in chat. To sign in now, call profile_setup — it reads the vault itself. Never ask for a site password. Never put a card number, CVV, or site password in the arguments.",
  inputSchema: vaultSetupRequestSchema,
  async execute(request, ctx) {
    const blocked = instinctBlocked(turnAttributes(ctx), "vault_setup");
    if (blocked) return blocked;
    const url = createVaultSetupUrl(cabinetBase(), request);
    return {
      url,
      message:
        "Открой ссылку, войди в кабинет и введи данные там. Номер карты в чат не пиши.",
    };
  },
});
