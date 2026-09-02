import { defineTool } from "eve/tools";
import { z } from "zod";
import { createProfileSetupUrl } from "../../convex/lib/browserProfilePolicy.ts";

function cabinetBase(): string {
  const raw =
    process.env.BRO_CABINET_BASE?.trim() || process.env.BRO_PAY_BASE?.trim() || "";
  if (!raw) {
    throw new Error(
      "BRO_CABINET_BASE (or BRO_PAY_BASE) is not set — cannot build a profile sync link",
    );
  }
  return raw.replace(/\/$/, "");
}

export default defineTool({
  description:
    "Give the human a cabinet link to sync their local Chrome cookies into Browser Use Cloud. The agent never receives passwords. Use this when browser_task returns needsProfileSync, or when a site login session expired. Do not ask for a password and do not use vault_setup for site logins.",
  inputSchema: z.object({}),
  async execute() {
    const url = createProfileSetupUrl(cabinetBase());
    return {
      url,
      message:
        "Открой ссылку на компьютере, где ты уже залогинен в Chrome. Запусти команду из кабинета — cookies уйдут в облако, пароль Bro не увидит. После синхронизации вставь Profile ID в кабинете.",
    };
  },
});
