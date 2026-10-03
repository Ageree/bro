import { vi } from "vitest";

const testEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://example.com",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test",
  // A fake project: tests reach Composio only through a stubbed fetch, and a
  // real key in the host shell must never be the one they send.
  COMPOSIO_API_KEY: "test-composio-key",
  COMPOSIO_GOOGLE_AUTH_CONFIG_ID: "ac_google_full",
  COMPOSIO_GOOGLE_READ_ONLY_AUTH_CONFIG_ID: "ac_google_read_only",
  COMPOSIO_NOTION_AUTH_CONFIG_ID: "ac_notion",
  COMPOSIO_SLACK_AUTH_CONFIG_ID: "ac_slack",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  SECRET_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
};

// Optional provider configuration must not leak in from the host shell: tests
// opt into RouterAI or OpenRouter explicitly and otherwise exercise the AI
// Gateway path.
// A Browser Use key in the shell would let a test that forgot a mock stop or
// delete a real browser or profile, so tests stub their own. The same goes
// for a Cloud.ru key and a real VM, and agent sessions do carry one.
const unsetEnvironment = [
  "BROWSER_BACKEND",
  "BROWSER_HOST_BUNDLE",
  "BROWSER_HOST_NAME_PREFIX",
  "BROWSER_HOST_RUNSC_RELEASE",
  "BROWSER_HOST_RUNTIME",
  "BROWSER_POOL_WORKSPACES",
  "BROWSER_SANDBOX_ROOTFS",
  "BROWSER_STATE_BUCKET",
  "BROWSER_STATE_KEY",
  "BROWSER_USE_API_KEY",
  "BROWSER_VM_LLM_API_KEY",
  "BROWSER_VM_PROXY",
  "BROWSER_VM_SIGNING_KEY",
  "BROWSER_VM_WORKSPACES",
  "CLOUDRU_BROWSER_IMAGE",
  "CLOUDRU_KEY_ID",
  "CLOUDRU_KEY_SECRET",
  "CLOUDRU_PRIVATE_ROUTING",
  "CLOUDRU_PROJECT_ID",
  "CLOUDRU_S3_TENANT_ID",
  "MODEL_PROVIDER",
  "OPENROUTER_API_KEY",
  "OPENROUTER_CREDITS_ALERT_USD",
  "OPENROUTER_IMAGE_MODEL",
  "OPENROUTER_MANAGEMENT_KEY",
  "OPENROUTER_MAX_OUTPUT_TOKENS",
  "OPENROUTER_MODEL",
  "OPENROUTER_MODEL_CONTEXT_TOKENS",
  "OPENROUTER_PROVIDER_ORDER",
  "OPENROUTER_REASONING_EFFORT",
  "OPENROUTER_SEARCH_MODEL",
  "OPENROUTER_STT_FALLBACK_MODEL",
  "OPENROUTER_STT_LANGUAGE",
  "OPENROUTER_STT_MODEL",
  "ROUTERAI_API_KEY",
  "ROUTERAI_BASE_URL",
  "ROUTERAI_CREDITS_ALERT_RUB",
  "ROUTERAI_IMAGE_MODEL",
  "ROUTERAI_MAX_OUTPUT_TOKENS",
  "ROUTERAI_MODEL",
  "ROUTERAI_MODEL_CONTEXT_TOKENS",
  "ROUTERAI_PROVIDER_IGNORE",
  "ROUTERAI_PROVIDER_ORDER",
  "ROUTERAI_REASONING_EFFORT",
  "ROUTERAI_SEARCH_MAX_RESULTS",
  "ROUTERAI_SEARCH_MODEL",
  "ROUTERAI_STT_FALLBACK_MODEL",
  "ROUTERAI_STT_LANGUAGE",
  "ROUTERAI_STT_MODEL",
  "SANDBOX_HOST_ID",
  "SANDBOX_HOST_ORIGIN",
  "SANDBOX_SIGNING_KEY",
  "SANDBOX_TOOLS_URL",
  "SANDBOX_WORKSPACES",
  "SKILLS_WORKSPACES",
  "STEP_CONTEXT_WORKSPACES",
  "SUBSCRIPTIONS_WORKSPACES",
  "TASK_AGENT_MODEL",
  "TELEGRAM_OWNER_CHAT_ID",
];

for (const [name, value] of Object.entries(testEnvironment)) {
  vi.stubEnv(name, value);
}

for (const name of unsetEnvironment) {
  vi.stubEnv(name, "");
}
