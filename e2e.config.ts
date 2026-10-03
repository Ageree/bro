import { github } from "@e2e-dev/github";
import { web } from "@e2e-dev/web";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { E2EConfig } from "e2e";
import { e2eEnv } from "./e2e/env.ts";
import { crossChannelPilotEmail } from "./e2e/pilots.ts";
import { testSecrets } from "./e2e/secrets.ts";

/**
 * The browser suite: `pnpm test:e2e` locally, the `e2e` job in CI. How to
 * run, write and extend it — docs/e2e.md.
 */

const model = e2eEnv.E2E_MODEL;

/**
 * DeepSeek hosts that answer a forced tool call with `{}` or a broken call
 * block — the runner forces every agent step. Measured for Bro itself;
 * `brokenHosts` in agent/lib/model/direct.ts says when and how. A copy: that
 * module validates the whole app environment when imported. Skipped only for
 * DeepSeek, as there: another model may have one of these hosts alone.
 */
const brokenDeepSeekHosts = [
  "sail-research",
  "modal",
  "parasail",
  "phala",
  "inference-net",
  "open-inference",
];

const openrouter = createOpenRouter({ apiKey: e2eEnv.OPENROUTER_API_KEY });

/** The app's model key, and a cloud session's proxy, when they are set. */
const passedThrough = Object.fromEntries(
  (
    [
      "HTTPS_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "NO_PROXY",
      "OPENROUTER_API_KEY",
    ] as const
  ).flatMap((name) => {
    const value = e2eEnv[name];
    return value === undefined ? [] : [[name, value]];
  })
);

/**
 * The app runs as local development: only `next dev` on a loopback
 * `BETTER_AUTH_URL` takes any phone without a code (`localPhoneAuthBypassEnabled`
 * in shared/environment/env.ts), and only a loopback URL may be plain HTTP.
 */
const appEnvironment = {
  ...passedThrough,
  BETTER_AUTH_URL: "http://127.0.0.1:{port}",
  // The cross-channel recap, for the one person its test gives this email
  // (e2e/chat/cross-channel.e2e.ts); everyone else runs as production does,
  // outside the pilot. The runner has no env per test, and a second target
  // would run the whole suite twice.
  CROSS_CHANNEL_WORKSPACES: crossChannelPilotEmail,
  MODEL_PROVIDER: "openrouter",
  NEXT_TELEMETRY_DISABLED: "1",
  OPENROUTER_MODEL: model,
  PORT: "{port}",
};

const database = e2eEnv.E2E_DATABASE_URL;

const app =
  e2eEnv.E2E_APP_URL === undefined
    ? {
        url: "http://127.0.0.1:0",
        // A port-0 URL keeps the replay cache across runs; the name keeps it
        // across machines too.
        identity: "bro-local",
        command:
          database === undefined
            ? {
                // Docker Postgres from compose.yaml, migrations, `next dev`.
                executable: "node",
                args: ["scripts/dev.ts"],
                env: appEnvironment,
                log: ".e2e/logs/app.log",
                shutdownTimeout: 30_000,
                startupTimeout: 300_000,
              }
            : {
                // The database is migrated beforehand (`pnpm db:migrate`).
                // `next` itself, not `pnpm dev:app`: pnpm in the runner's bare
                // environment wanted to reinstall node_modules and aborted
                // without a TTY (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
                executable: "next",
                args: ["dev"],
                env: {
                  ...appEnvironment,
                  DATABASE_URL: database,
                  DATABASE_URL_UNPOOLED: database,
                },
                log: ".e2e/logs/app.log",
                startupTimeout: 300_000,
              },
      }
    : { url: e2eEnv.E2E_APP_URL, identity: "bro-local" };

export default {
  tests: "e2e/**/*.e2e.ts",
  targets: [{ engine: web(), app }],
  // `next dev` compiles each route on its first visit, tens of seconds on a
  // CI runner.
  actionTimeout: 90_000,
  assertionTimeout: 15_000,
  timeout: 240_000,
  // `junit` and `markdown` feed CI's artifact, `github()` its PR comment.
  reporters: ["list", "junit", "markdown", github()],
  secrets: testSecrets,
  agents: {
    default: {
      model: openrouter.chat(model, {
        provider: {
          ignore: model.startsWith("deepseek/") ? brokenDeepSeekHosts : [],
        },
      }),
      // DeepSeek V4 thinks by default and then refuses a forced tool call;
      // a step needs no thinking to tap a link.
      providerOptions: { openrouter: { reasoning: { enabled: false } } },
      context: [
        "The app under test is Bro (bro.), a personal AI agent people text in",
        "Russian; the whole interface is in Russian. «Кабинет» (/workspace) is",
        "the dashboard, «Сейф» (/vault) holds cards and site logins, «Личные",
        "данные» (/personal-info) the profile and time zone, «Чат» (/chat) a",
        "conversation with Bro and «Все чаты» (/chat/history) the list of",
        "conversations. Bro answers in the chat after a few seconds to a",
        "minute; its replies are generated, so judge their meaning, not exact",
        "words.",
      ].join(" "),
    },
  },
} satisfies E2EConfig;
