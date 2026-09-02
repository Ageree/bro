import { defineTool } from "eve/tools";
import {
  createVaultSetupUrl,
  vaultSetupRequestSchema,
} from "../../convex/lib/vaultPayload.ts";

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
    "Give the human a cabinet link to save a vault item. Supported kinds: payment, address, contact. Do not use this for site logins — those go through profile_setup (Chrome cookie sync). Never put a card number, CVV, or any other secret in the arguments — the human types those on the page, never in chat.",
  inputSchema: vaultSetupRequestSchema,
  async execute(request) {
    const url = createVaultSetupUrl(cabinetBase(), request);
    return {
      url,
      message:
        "Открой ссылку, войди в кабинет и введи данные там. Пароль и номер карты в чат не пиши.",
    };
  },
});
