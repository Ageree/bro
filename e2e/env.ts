import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

const optionalValue = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

/**
 * What the e2e runner reads from its own environment. The runner hands the
 * app only `PATH`, `HOME` and what `e2e.config.ts` passes on, so a developer's
 * production keys in `.env.local` or the shell never reach the app through
 * it; Next.js still loads `.env.local` itself in `next dev`, below these.
 */
export const e2eEnv = createEnv({
  server: {
    // An app already serving elsewhere: the runner starts nothing.
    E2E_APP_URL: optionalValue.pipe(z.url().optional()),
    // A database the run may write to; without it `scripts/dev.ts` brings up
    // the local Docker Postgres. Never a shared or production database: the
    // suite signs up people and writes their chats.
    E2E_DATABASE_URL: optionalValue,
    // The model behind both the runner's agent steps and Bro itself.
    E2E_MODEL: z.string().trim().min(1).default("deepseek/deepseek-v4.1-flash"),
    // Keys pasted into a secret store arrive with line breaks inside; a
    // header refuses them, and the error then prints the key.
    OPENROUTER_API_KEY: optionalValue.transform((value) =>
      value?.replaceAll(/\s/gu, "")
    ),
    // An outbound proxy and its CA (a cloud agent session) must reach the
    // app, or every model call fails on the certificate chain.
    HTTPS_PROXY: optionalValue,
    NODE_EXTRA_CA_CERTS: optionalValue,
    NO_PROXY: optionalValue,
  },
  experimental__runtimeEnv: {},
});
