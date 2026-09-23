import type { KnipConfig } from "knip";

export default {
  entry: [
    "agent/channels/**/*.ts",
    "agent/connections/**/*.ts",
    "agent/hooks/**/*.ts",
    "agent/instructions/**/*.ts",
    // eve discovers each path-named instrumentation file in this directory.
    "agent/instrumentation/**/*.ts",
    "agent/memory/**/*.ts",
    "agent/schedules/**/*.ts",
    "agent/tools/**/*.ts",
    "db/drizzle.config.ts",
    // Drizzle consumes every table and relation exported by this schema barrel.
    "db/schema/index.ts",
    "evals/**/*.eval.ts",
    "evals/evals.config.ts",
    // A one-off maintenance CLI, run by hand rather than from package.json.
    "scripts/migrate-from-convex.ts",
    "taze.config.ts",
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
  ],
  ignoreIssues: {
    // Eve AI Elements and shadcn registry primitives intentionally expose
    // a reusable component surface wider than this minimal chat consumes.
    "web/components/ai-elements/**/*.tsx": ["exports", "files", "types"],
    "web/components/ui/**/*.tsx": ["exports", "files", "types"],
  },
  project: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
} satisfies KnipConfig;
