export default {
  includeLocked: true,
  maturityPeriodExclude: ["@vercel/*", "eve"],
  mode: "major",
  packageMode: {
    "@types/node": "minor",
    // Pinned to the Workflow line eve 0.62 vendors (world 5.0.0-beta.36):
    // the world's own migrations and its graphile-worker move together with
    // eve, never on their own (scripts/cloudru-app-host/ops/migrate.ts).
    "@workflow/world-postgres": "ignore",
    "graphile-worker": "ignore",
    typescript: "minor",
  },
  recursive: true,
};
