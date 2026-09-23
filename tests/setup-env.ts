import { vi } from "vitest";

const testEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://example.com",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  SECRET_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
};

// Optional provider configuration must not leak in from the host shell: tests
// opt into OpenRouter explicitly and otherwise exercise the AI Gateway path.
const unsetEnvironment = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_CREDITS_ALERT_USD",
  "OPENROUTER_MANAGEMENT_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_MODEL_CONTEXT_TOKENS",
  "OPENROUTER_PROVIDER_ORDER",
  "OPENROUTER_REASONING_EFFORT",
  "OPENROUTER_SEARCH_MODEL",
  "OPENROUTER_STT_FALLBACK_MODEL",
  "OPENROUTER_STT_LANGUAGE",
  "OPENROUTER_STT_MODEL",
  "OWNER_TELEGRAM_CHAT_ID",
];

for (const [name, value] of Object.entries(testEnvironment)) {
  vi.stubEnv(name, value);
}

for (const name of unsetEnvironment) {
  vi.stubEnv(name, "");
}
