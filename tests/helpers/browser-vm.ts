import { vi } from "vitest";

/**
 * A deployment with the Cloud.ru browser backend fully configured. The
 * signing key is the one of the token test vector that the worker's own
 * tests check (`browser-vm/worker/test_worker.py`).
 */
export const browserVmTestEnvironment = {
  BROWSER_VM_LLM_API_KEY: "routerai-test-key",
  BROWSER_VM_PROXY: "proxy.example.test:9000:user-session-{session}:pa:ss",
  BROWSER_VM_SIGNING_KEY: "11".repeat(32),
  CLOUDRU_BROWSER_IMAGE: "bro-browser-test-1",
  CLOUDRU_KEY_ID: "test-key-id",
  CLOUDRU_KEY_SECRET: "test-key-secret",
};

/** Every setting of the backend a test may stub, cleared between tests. */
const browserVmSettings = [
  "BROWSER_BACKEND",
  "BROWSER_VM_IDLE_BACKGROUND_MINUTES",
  "BROWSER_VM_IDLE_CODE_MINUTES",
  "BROWSER_VM_IDLE_MINUTES",
  "BROWSER_VM_LLM_API_KEY",
  "BROWSER_VM_LLM_BASE_URL",
  "BROWSER_VM_MODEL",
  "BROWSER_VM_PROXY",
  "BROWSER_VM_SIGNING_KEY",
  "BROWSER_VM_TWOCAPTCHA_API_KEY",
  "BROWSER_VM_WORKSPACES",
  "CLOUDRU_BROWSER_DISK_GB",
  "CLOUDRU_BROWSER_FLAVOR",
  "CLOUDRU_BROWSER_IMAGE",
  "CLOUDRU_KEY_ID",
  "CLOUDRU_KEY_SECRET",
  "CLOUDRU_PROJECT_ID",
  "CLOUDRU_SECURITY_GROUP",
  "CLOUDRU_SUBNET",
  "CLOUDRU_ZONE",
] as const;

/**
 * Import a module against these settings. `env` is parsed once per module
 * graph, so the graph is loaded afresh after the stubs are in place.
 */
export async function importWithSettings<T>(
  settings: Readonly<
    Partial<Record<(typeof browserVmSettings)[number], string>>
  >,
  load: () => Promise<T>
) {
  vi.resetModules();
  for (const [name, value] of Object.entries(settings)) {
    vi.stubEnv(name, value);
  }
  return load();
}

/**
 * Clearing every stub would also drop the values `tests/setup-env.ts`
 * installs, so only these settings go back to unset.
 */
export function clearBrowserVmSettings() {
  for (const name of browserVmSettings) vi.stubEnv(name, "");
}
