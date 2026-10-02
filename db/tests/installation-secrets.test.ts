import { beforeEach, describe, expect, it, vi } from "vitest";

const betterAuthSecret = Buffer.alloc(32, 4).toString("base64");
const secretEncryptionKey = Buffer.alloc(32, 5).toString("base64");

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("BETTER_AUTH_SECRET", betterAuthSecret);
  vi.stubEnv("SECRET_ENCRYPTION_KEY", secretEncryptionKey);
});

describe("installation secrets", () => {
  it("reads both secrets from the environment", async () => {
    const { getInstallationSecrets } =
      await import("@db/services/installation-secrets");

    expect(getInstallationSecrets()).toEqual({
      betterAuthSecret,
      secretEncryptionKey,
    });
  });

  it.each(["BETTER_AUTH_SECRET", "SECRET_ENCRYPTION_KEY"])(
    "refuses to run without %s rather than make one up",
    async (name) => {
      vi.stubEnv(name, "");
      const { getInstallationSecrets } =
        await import("@db/services/installation-secrets");

      expect(() => getInstallationSecrets()).toThrow(
        "Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY"
      );
    }
  );
});
