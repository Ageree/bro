import { vi } from "vitest";

/** A deployment with the code sandbox host and its Object Storage configured. */
const sandboxTestEnvironment = {
  BETTER_AUTH_URL: "https://bro.example.test",
  BROWSER_STATE_BUCKET: "bro-state-test",
  CLOUDRU_KEY_ID: "test-key-id",
  CLOUDRU_KEY_SECRET: "test-key-secret",
  CLOUDRU_S3_TENANT_ID: "test-tenant",
  SANDBOX_HOST_ID: "sbx-code-1",
  SANDBOX_HOST_ORIGIN: "https://10-0-0-1.sslip.io",
  SANDBOX_SIGNING_KEY: "33".repeat(32),
};

/**
 * What each setting stubbed here held before, so that clearing puts back
 * exactly that: an override of any other key (SANDBOX_WORKSPACES,
 * OPENROUTER_API_KEY) must not leak into the next test either.
 */
const replaced = new Map<string, string | undefined>();

/**
 * Imports a module against these settings: `env` is parsed once per module
 * graph, so the graph is loaded afresh after the stubs are in place.
 */
export async function importWithSandbox<T>(
  load: () => Promise<T>,
  overrides: Readonly<Record<string, string>> = {}
) {
  vi.resetModules();
  for (const [name, value] of Object.entries({
    ...sandboxTestEnvironment,
    ...overrides,
  })) {
    // A test helper puts back the raw value it replaced; no setting is read.
    // oxlint-disable-next-line eslint/no-restricted-properties -- See above.
    if (!replaced.has(name)) replaced.set(name, process.env[name]);
    vi.stubEnv(name, value);
  }
  return await load();
}

/**
 * Clearing every stub would also drop the values `tests/setup-env.ts`
 * installs, so only the settings stubbed here go back to what they were.
 */
export function clearSandboxSettings() {
  for (const [name, value] of replaced) vi.stubEnv(name, value ?? "");
  replaced.clear();
}
