import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://example.com",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

describe("environment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [name, value] of Object.entries(requiredEnvironment)) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv("IMESSAGE_PHONE_NUMBER", "");
    vi.stubEnv("IMESSAGE_PROJECT_ID", "");
    vi.stubEnv("IMESSAGE_PROJECT_SECRET", "");
    vi.stubEnv("IMESSAGE_WEBHOOK_SECRET", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("exports the validated environment", async () => {
    const { env } = await import("@shared/environment");

    expect(env).toMatchObject(requiredEnvironment);
  });

  it("provides the Google connector default without enabling iMessage", async () => {
    vi.stubEnv("GOOGLE_CONNECTOR_UID", "");

    const { env } = await import("@shared/environment");

    expect(env.GOOGLE_CONNECTOR_UID).toBe("google/open-instinct");
    expect(env.IMESSAGE_PROJECT_ID).toBeUndefined();
    expect(env.IMESSAGE_PROJECT_SECRET).toBeUndefined();
    expect(env.IMESSAGE_WEBHOOK_SECRET).toBeUndefined();
    expect(env.IMESSAGE_PHONE_NUMBER).toBeUndefined();
  });

  it("provides stable auth and encryption defaults in local development", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("SECRET_ENCRYPTION_KEY", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", undefined);

    const { env, localPhoneAuthBypassEnabled } =
      await import("@shared/environment");

    expect(env).toMatchObject({
      BETTER_AUTH_SECRET: "openinstinct-local-auth-development-secret",
      BETTER_AUTH_URL: "http://localhost:3000",
      SECRET_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(localPhoneAuthBypassEnabled).toBe(true);
  });

  it.each([
    ["test-auth-secret-0123456789abcdefghijklmnop", ""],
    ["", Buffer.alloc(32, 2).toString("base64")],
  ])(
    "rejects asymmetric local installation-secret overrides",
    async (betterAuthSecret, secretEncryptionKey) => {
      vi.stubEnv("BETTER_AUTH_SECRET", betterAuthSecret);
      vi.stubEnv("SECRET_ENCRYPTION_KEY", secretEncryptionKey);
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("VERCEL_ENV", undefined);

      await expect(import("@shared/environment")).rejects.toThrow(
        "Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY"
      );
    }
  );

  it("accepts connector and Photon project overrides", async () => {
    vi.stubEnv("GOOGLE_CONNECTOR_UID", "google/custom");
    vi.stubEnv("IMESSAGE_PROJECT_ID", "photon-project");
    vi.stubEnv("IMESSAGE_PROJECT_SECRET", "photon-secret");
    vi.stubEnv("IMESSAGE_WEBHOOK_SECRET", "photon-webhook-secret");
    vi.stubEnv("IMESSAGE_PHONE_NUMBER", "+12025550123");

    const { env } = await import("@shared/environment");

    expect(env.GOOGLE_CONNECTOR_UID).toBe("google/custom");
    expect(env.IMESSAGE_PROJECT_ID).toBe("photon-project");
    expect(env.IMESSAGE_PROJECT_SECRET).toBe("photon-secret");
    expect(env.IMESSAGE_WEBHOOK_SECRET).toBe("photon-webhook-secret");
    expect(env.IMESSAGE_PHONE_NUMBER).toBe("+12025550123");
  });

  it("does not provide local defaults in a Vercel development environment", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("SECRET_ENCRYPTION_KEY", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("VERCEL_URL", "open-instinct-preview.vercel.app");

    const { env } = await import("@shared/environment");

    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.BETTER_AUTH_URL).toBeUndefined();
    expect(env.SECRET_ENCRYPTION_KEY).toBeUndefined();
  });

  it("keeps DATABASE_URL required in local development", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", undefined);

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it.each([
    requiredEnvironment.SECRET_ENCRYPTION_KEY.slice(0, -1),
    Buffer.alloc(32, 255).toString("base64url"),
  ])("accepts a Node-compatible 32-byte encryption key", async (key) => {
    vi.stubEnv("SECRET_ENCRYPTION_KEY", key);

    const { env } = await import("@shared/environment");
    expect(env.SECRET_ENCRYPTION_KEY).toBe(key);
  });

  it("rejects a missing required DATABASE_URL value during import", async () => {
    vi.stubEnv("DATABASE_URL", "");

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("rejects an encryption key that does not decode to 32 bytes", async () => {
    vi.stubEnv("SECRET_ENCRYPTION_KEY", Buffer.alloc(31, 1).toString("base64"));

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("rejects a non-Postgres database URL", async () => {
    vi.stubEnv("DATABASE_URL", "https://example.com/database");

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("accepts a Photon project without a copied phone number", async () => {
    vi.stubEnv("IMESSAGE_PROJECT_ID", "photon-project");
    vi.stubEnv("IMESSAGE_PROJECT_SECRET", "photon-secret");
    vi.stubEnv("IMESSAGE_PHONE_NUMBER", "");

    const { env } = await import("@shared/environment");

    expect(env.IMESSAGE_PROJECT_ID).toBe("photon-project");
    expect(env.IMESSAGE_PHONE_NUMBER).toBeUndefined();
  });

  it("accepts Vercel OIDC Blob storage without a static token", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("BLOB_STORE_ID", "store_openinstinct");

    const { env } = await import("@shared/environment");

    expect(env.BLOB_READ_WRITE_TOKEN).toBeUndefined();
    expect(env.BLOB_STORE_ID).toBe("store_openinstinct");
  });

  it("rejects an iMessage phone number outside E.164 format", async () => {
    vi.stubEnv("IMESSAGE_PROJECT_ID", "photon-project");
    vi.stubEnv("IMESSAGE_PHONE_NUMBER", "(202) 555-0123");

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it.each([
    ["http://localhost:3000", "development", undefined, true],
    ["https://openinstinct.localhost", "development", undefined, true],
    ["http://localhost:3000", "production", undefined, false],
    ["http://localhost:3000", "development", "development", false],
    ["https://preview.example.com", "development", undefined, false],
  ] as const)(
    "resolves local phone auth bypass for %s in %s",
    async (url, nodeEnv, vercelEnv, expected) => {
      vi.stubEnv("BETTER_AUTH_URL", url);
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("VERCEL_ENV", vercelEnv);

      const { localPhoneAuthBypassEnabled } =
        await import("@shared/environment");

      expect(localPhoneAuthBypassEnabled).toBe(expected);
    }
  );
});
