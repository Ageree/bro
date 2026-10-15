import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const applicationEnvironment = [
  "ACCESS_*",
  "ADMIN_*",
  "AGENTMAIL_*",
  "BETTER_AUTH_*",
  // Login and vault keys still fall back to Blob on Vercel
  // (db/services/installation-secrets.ts).
  "BLOB_*",
  "BROWSER_BACKEND",
  "BROWSER_HOST_*",
  "BROWSER_POOL_*",
  "BROWSER_SANDBOX_*",
  "BROWSER_STATE_*",
  "BROWSER_USE_*",
  "BROWSER_VM_*",
  "BUG_BOT*",
  "CLOUDRU_*",
  "COMPOSIO_*",
  "DATABASE_DRIVER",
  "DATABASE_URL",
  "ELEVENLABS_*",
  "EVE_SCHEDULES",
  "FREE_*",
  "IMESSAGE_*",
  "MAILRU_MAIL_*",
  "YANDEX_MAIL_*",
  "YANDEX_API_WORKSPACES",
  "YANDEX_DIRECT_WORKSPACES",
  "YANDEX_PURCHASE_WORKSPACES",
  "DIRECT_PURCHASE_WORKSPACES",
  "DIRECT_PURCHASE_MAX_RUB",
  "ERRAND_AUTONOMY_WORKSPACES",
  "MAIL_WORKSPACES",
  "YOOMONEY_*",
  "MODEL_PROVIDER",
  "MTS_EXOLVE_*",
  "NODE_ENV",
  "OPENROUTER_*",
  "OPS_ALERT_*",
  "OWNER_*",
  "PAID_*",
  "PHONE_*",
  "PRICE_RUB",
  "ROUTERAI_*",
  "S3_*",
  "SECRET_ENCRYPTION_KEY",
  "SUPERMEMORY_*",
  "TELEGRAM_*",
  "VERCEL_*",
  "YOOKASSA_*",
];
const runtimeEnvironment = applicationEnvironment;

describe("Turbo configuration", () => {
  it("scopes application environment variables to their owning tasks", async () => {
    const turbo = z
      .object({
        tasks: z.object({
          "build:app": z.object({ env: z.array(z.string()) }),
          "build:vercel": z.object({ env: z.array(z.string()) }),
          "dev:app": z.object({ passThroughEnv: z.array(z.string()) }),
          "start:app": z.object({ passThroughEnv: z.array(z.string()) }),
        }),
      })
      .loose()
      .parse(
        JSON.parse(
          await readFile(new URL("../turbo.json", import.meta.url), "utf8")
        )
      );

    expect(turbo).not.toHaveProperty("globalEnv");
    expect(turbo.tasks["build:app"].env).toEqual(
      expect.arrayContaining([
        ...applicationEnvironment,
        "EVE_NEXT_*",
        "NEXT_OUTPUT",
      ])
    );
    expect(turbo.tasks["build:app"].env).toHaveLength(
      applicationEnvironment.length + 2
    );
    expect(turbo.tasks["build:vercel"].env).toEqual(applicationEnvironment);
    expect(turbo.tasks["dev:app"].passThroughEnv).toEqual(runtimeEnvironment);
    expect(turbo.tasks["start:app"].passThroughEnv).toEqual(runtimeEnvironment);
  });
});
