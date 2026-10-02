/**
 * The suite's fixed test values: not credentials, but the runner fills them
 * without the model seeing them, as it would a real password. Tests that
 * check a value never shows on screen read it from here.
 */
export const testSecrets = { "vault-password": "e2e-vault-password" } as const;
