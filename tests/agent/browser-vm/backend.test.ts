import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserPoolTestEnvironment,
  browserVmTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

const accounts = vi.hoisted(() => ({
  readAccountEmail:
    vi.fn<(scope: { userId: string }) => Promise<string | undefined>>(),
  readWorkspaceScope:
    vi.fn<
      (
        workspaceId: string
      ) => Promise<{ userId: string; workspaceId: string } | null>
    >(),
}));

vi.mock("@db/services/users", () => ({
  readAccountEmail: accounts.readAccountEmail,
}));

vi.mock("@db/services/scope", () => ({
  readWorkspaceScope: accounts.readWorkspaceScope,
}));

const workspaceId = "personal:0123456789abcdef0123456789abcdef";
const ownerId = "better-auth:alice";

beforeEach(() => {
  accounts.readAccountEmail.mockResolvedValue("Alice@Example.com");
  accounts.readWorkspaceScope.mockResolvedValue({
    userId: ownerId,
    workspaceId,
  });
});

afterEach(() => {
  clearBrowserVmSettings();
  vi.clearAllMocks();
  vi.resetModules();
});

async function loadBackend(settings = {}) {
  return importWithSettings(
    { ...browserVmTestEnvironment, ...settings },
    async () => import("@agent/lib/browser-vm/backend")
  );
}

describe("browser VM backend choice", () => {
  it("is configured only with every key, the image, the proxy and the model key", async () => {
    expect((await loadBackend()).browserVmConfigured()).toBe(true);
    const names = Object.keys(browserVmTestEnvironment);
    const configuredWithout: [string, boolean][] = [];
    for (const name of names) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each setting is left out of its own freshly parsed environment, one at a time.
      const backend = await loadBackend({ [name]: "" });
      configuredWithout.push([name, backend.browserVmConfigured()]);
    }
    expect(configuredWithout).toEqual(names.map((name) => [name, false]));
  });

  it("stays on Browser Use when the VM backend is not configured, whatever is asked", async () => {
    const backend = await loadBackend({
      BROWSER_BACKEND: "cloudru",
      BROWSER_VM_WORKSPACES: workspaceId,
      CLOUDRU_BROWSER_IMAGE: "",
    });

    expect(await backend.usesBrowserVm({ workspaceId })).toBe(false);
  });

  it("sends every workspace to its VM once the default is cloudru", async () => {
    const backend = await loadBackend({ BROWSER_BACKEND: "cloudru" });

    expect(await backend.usesBrowserVm({ workspaceId })).toBe(true);
    expect(accounts.readWorkspaceScope).not.toHaveBeenCalled();
  });

  it("sends a pilot workspace named by its id, and no other", async () => {
    const backend = await loadBackend({
      BROWSER_VM_WORKSPACES: ` other , ${workspaceId} ,`,
    });

    expect(await backend.usesBrowserVm({ workspaceId })).toBe(true);
    expect(await backend.usesBrowserVm({ workspaceId: "personal:else" })).toBe(
      false
    );
    // Without an email in the list nobody's account is looked up.
    expect(accounts.readWorkspaceScope).not.toHaveBeenCalled();
    expect(accounts.readAccountEmail).not.toHaveBeenCalled();
  });

  it("sends a pilot workspace named by its owner's email, in any case", async () => {
    const backend = await loadBackend({
      BROWSER_VM_WORKSPACES: "someone@example.com, alice@example.COM",
    });

    expect(await backend.usesBrowserVm({ workspaceId })).toBe(true);
    expect(accounts.readWorkspaceScope).toHaveBeenCalledWith(workspaceId);
    expect(accounts.readAccountEmail).toHaveBeenCalledWith({
      userId: ownerId,
      workspaceId,
    });
  });

  it("takes the owner from the caller's scope when it has one", async () => {
    const backend = await loadBackend({
      BROWSER_VM_WORKSPACES: "alice@example.com",
    });

    expect(await backend.usesBrowserVm({ userId: ownerId, workspaceId })).toBe(
      true
    );
    expect(accounts.readWorkspaceScope).not.toHaveBeenCalled();
  });

  it("keeps a workspace whose owner is someone else, or nobody, on Browser Use", async () => {
    const backend = await loadBackend({
      BROWSER_VM_WORKSPACES: "someone@example.com",
    });

    expect(await backend.usesBrowserVm({ workspaceId })).toBe(false);
    accounts.readWorkspaceScope.mockResolvedValueOnce(null);
    expect(await backend.usesBrowserVm({ workspaceId })).toBe(false);
    accounts.readAccountEmail.mockResolvedValueOnce(undefined);
    expect(
      await backend.usesBrowserVm({ userId: "telegram:1", workspaceId })
    ).toBe(false);
  });

  it("configures the pool only with all its pieces, without the VM image", async () => {
    const pool = await loadBackend(browserPoolTestEnvironment);
    expect(pool.browserPoolConfigured()).toBe(true);
    expect(pool.browserVmConfigured()).toBe(false);

    const names = Object.entries(browserPoolTestEnvironment)
      .filter(([, value]) => value !== "")
      .map(([name]) => name);
    const configuredWithout: [string, boolean][] = [];
    for (const name of names) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each setting is left out of its own freshly parsed environment, one at a time.
      const backend = await loadBackend({
        ...browserPoolTestEnvironment,
        [name]: "",
      });
      configuredWithout.push([name, backend.browserPoolConfigured()]);
    }
    expect(configuredWithout).toEqual(names.map((name) => [name, false]));
  });

  it("leaves everyone off the pool while it is not configured", async () => {
    const backend = await loadBackend({
      BROWSER_BACKEND: "pool",
      BROWSER_POOL_WORKSPACES: `${workspaceId}, alice@example.com`,
    });

    expect(await backend.usesBrowserPool({ workspaceId })).toBe(false);
    // The VM backend is configured and nobody is in its pilot: Browser Use.
    expect(await backend.usesBrowserVm({ workspaceId })).toBe(false);
    expect(accounts.readWorkspaceScope).not.toHaveBeenCalled();
    expect(accounts.readAccountEmail).not.toHaveBeenCalled();
  });

  it("sends a pool pilot workspace to its own browser, without the VM image", async () => {
    const backend = await loadBackend({
      ...browserPoolTestEnvironment,
      BROWSER_POOL_WORKSPACES: "someone@example.com, ALICE@example.com",
    });

    expect(await backend.usesBrowserPool({ workspaceId })).toBe(true);
    expect(await backend.usesBrowserVm({ workspaceId })).toBe(true);
    accounts.readAccountEmail.mockResolvedValue("bob@example.com");
    expect(await backend.usesBrowserPool({ workspaceId })).toBe(false);
    // Not in the pool, and no VM image for the VM backend.
    expect(await backend.usesBrowserVm({ workspaceId })).toBe(false);
  });

  it("sends every workspace to the pool once the default is pool", async () => {
    const backend = await loadBackend({
      ...browserPoolTestEnvironment,
      BROWSER_BACKEND: "pool",
    });

    expect(await backend.usesBrowserPool({ workspaceId })).toBe(true);
    expect(await backend.usesBrowserVm({ workspaceId })).toBe(true);
    expect(accounts.readWorkspaceScope).not.toHaveBeenCalled();
  });

  it("keeps a VM pilot workspace on its VM when the pool has others", async () => {
    const backend = await loadBackend({
      ...browserPoolTestEnvironment,
      BROWSER_POOL_WORKSPACES: "personal:pool",
      BROWSER_VM_WORKSPACES: workspaceId,
      CLOUDRU_BROWSER_IMAGE: "bro-browser-test-1",
    });

    expect(await backend.usesBrowserPool({ workspaceId })).toBe(false);
    expect(await backend.usesBrowserVm({ workspaceId })).toBe(true);
    expect(
      await backend.usesBrowserPool({ workspaceId: "personal:pool" })
    ).toBe(true);
  });

  it("reads the pool's settings in their documented formats", async () => {
    const { env } = await importWithSettings(
      {
        ...browserPoolTestEnvironment,
        BROWSER_HOST_BUNDLE: ` hosts/b-2.tgz:${"ef".repeat(32)} `,
        BROWSER_SANDBOX_ROOTFS: `v7:rootfs/v7.tar.zst:${"01".repeat(32)}`,
      },
      async () => import("@shared/environment")
    );

    expect(env.BROWSER_HOST_BUNDLE).toEqual({
      key: "hosts/b-2.tgz",
      sha256: "ef".repeat(32),
    });
    expect(env.BROWSER_SANDBOX_ROOTFS).toEqual({
      key: "rootfs/v7.tar.zst",
      sha256: "01".repeat(32),
      version: "v7",
    });
    expect(env).toMatchObject({
      BROWSER_HOST_FLAVOR: "gen-4-16",
      BROWSER_HOST_IDLE_MINUTES: 60,
      BROWSER_HOST_MAX: 1,
      BROWSER_SANDBOX_MEMORY_MB: 3072,
      CLOUDRU_S3_TENANT_ID: "test-tenant",
    });

    for (const settings of [
      { BROWSER_SANDBOX_ROOTFS: `rootfs/v7.tar.zst:${"01".repeat(32)}` },
      { BROWSER_HOST_BUNDLE: "hosts/b-2.tgz:abc" },
      { BROWSER_HOST_RUNSC_RELEASE: "latest" },
      { BROWSER_STATE_KEY: "22".repeat(16) },
      { BROWSER_BACKEND: "firecracker" },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each bad value is parsed in an environment of its own.
      await expect(
        importWithSettings(
          { ...browserPoolTestEnvironment, ...settings },
          async () => import("@shared/environment")
        )
      ).rejects.toThrow("Invalid environment variables");
    }
  });

  it("hands the VM's agent the configured model and key", async () => {
    const backend = await loadBackend({
      BROWSER_VM_LLM_API_KEY: "“routerai-\nkey”",
    });

    expect(backend.browserVmLlm()).toEqual({
      apiKey: "routerai-key",
      baseUrl: "https://routerai.ru/api/v1",
      model: "deepseek/deepseek-v4.1-flash",
    });
  });
});
