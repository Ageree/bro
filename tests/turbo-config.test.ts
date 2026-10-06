import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const applicationEnvironment = [
  "ACCESS_*",
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
  "CLOUDRU_*",
  "COMPOSIO_*",
  "DATABASE_DRIVER",
  "DATABASE_URL",
  "ELEVENLABS_*",
  "EVE_SCHEDULES",
  "FREE_*",
  "IMESSAGE_*",
  "MODEL_PROVIDER",
  "MTS_EXOLVE_*",
  "NODE_ENV",
  "OPENROUTER_*",
  "OPS_ALERT_*",
  "PAID_*",
  "PHONE_*",
  "PRICE_RUB",
  "ROUTERAI_*",
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

  it("provisions required one-click deployment configuration", async () => {
    const readme = await readFile(
      new URL("../README.md", import.meta.url),
      "utf8"
    );
    const deployButtons = [
      ...readme.matchAll(
        /\[!\[Deploy with Vercel\]\([^)]+\)\]\((https:\/\/vercel\.com\/new\/clone\?[^)]+)\)/gu
      ),
    ].map((match) => new URL(z.url().parse(match[1])));
    expect(deployButtons).toHaveLength(1);
    const [deployButton] = deployButtons;
    expect(deployButton).toBeDefined();
    const fileStorage = readme
      .split("### File storage", 2)[1]
      ?.split("### Photon iMessage setup", 1)[0];

    expect(deployButton?.searchParams.get("repository-url")).toBe(
      "https://github.com/Merit-Systems/OpenInstinct"
    );
    expect(deployButton?.searchParams.has("env")).toBe(false);
    expect(deployButton?.searchParams.has("products")).toBe(false);
    expect(
      JSON.parse(deployButton?.searchParams.get("stores") ?? "null")
    ).toEqual([
      {
        integrationSlug: "neon",
        productSlug: "neon",
        protocol: "storage",
        type: "integration",
      },
    ]);
    expect(deployButton?.searchParams.has("connect")).toBe(false);
    expect(fileStorage).toContain("BROWSER_STATE_BUCKET");
    expect(fileStorage).toContain("revisioned database records");
    expect(fileStorage).not.toContain("vercel blob");
  });
});
