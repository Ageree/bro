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
// opt into OpenRouter explicitly and otherwise exercise the AI Gateway path.
// A Browser Use key in the shell would let a test that forgot a mock stop or
// delete a real browser or profile, so tests stub their own.
const unsetEnvironment = [
  "BROWSER_USE_API_KEY",
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
  "TELEGRAM_OWNER_CHAT_ID",
];

for (const [name, value] of Object.entries(testEnvironment)) {
  vi.stubEnv(name, value);
}

for (const name of unsetEnvironment) {
  vi.stubEnv(name, "");
}
