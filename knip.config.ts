import type { KnipConfig } from "knip";

export default {
  entry: [
    "agent/channels/**/*.ts",
    "agent/hooks/**/*.ts",
    "agent/instructions/**/*.ts",
    // eve discovers each path-named instrumentation file in this directory.
    "agent/instrumentation/**/*.ts",
    "agent/memory/**/*.ts",
    "agent/schedules/**/*.ts",
    "agent/tools/**/*.ts",
    // eve discovers each declared subagent's agent, sandbox and tools.
    "agent/subagents/**/*.ts",
    "db/drizzle.config.ts",
    // The browser suite: the e2e runner loads its config and test files.
    "e2e.config.ts",
    "e2e/**/*.e2e.ts",
    // Drizzle consumes every table and relation exported by this schema barrel.
    "db/schema/index.ts",
    "evals/**/*.eval.ts",
    "evals/evals.config.ts",
    // A one-off maintenance CLI, run by hand rather than from package.json.
    "scripts/migrate-from-convex.ts",
    "scripts/phone/*.ts",
    // Copies Vercel Blob to Object Storage by hand (docs/cloudru-migration.md).
    "scripts/cloudru-app-host/blob-to-s3.ts",
    // Measures the main agent's step context by hand (`docs/agent-costs.md`).
    "scripts/costs/step-context.ts",
    // Bundled into a release by scripts/cloudru-app-host/host.py and run on the VM.
    "scripts/cloudru-app-host/ops/migrate.ts",
    "scripts/cloudru-app-host/ops/agent-mail.ts",
    "taze.config.ts",
    // End-to-end runs against real clouds, by hand (docs/browser-pool.md).
    "tests/e2e/**/*.e2e.ts",
    "vitest.e2e.config.ts",
  ],
  ignoreDependencies: [
    // Imported through the owning Tailwind stylesheet rather than TypeScript.
    "shadcn",
    "tailwindcss",
    // Loaded as jsPlugins from .oxlintrc.jsonc rather than TypeScript.
    "eslint-plugin-react-hooks",
    "eslint-plugin-turbo",
    "oxlint-tailwindcss",
    // Invoked as a CLI.
    "vercel",
    // Bundles ops/migrate.ts for the Cloud.ru VM (scripts/cloudru-app-host/host.py).
    "esbuild",
    // Named, not imported: agent/agent.ts gives eve the package name of the
    // Workflow world, and eve bundles it.
    "@workflow/world-postgres",
  ],
  ignoreIssues: {
    // Eve AI Elements and shadcn registry primitives intentionally expose
    // a reusable component surface wider than this minimal chat consumes.
    "web/components/ai-elements/**/*.tsx": ["exports", "files", "types"],
    "web/components/ui/**/*.tsx": ["exports", "files", "types"],
  },
  project: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
} satisfies KnipConfig;
