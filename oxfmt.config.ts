export default {
  ignorePatterns: [
    "tools/oxlint/anti-slop/**",
    // The model's instructions: their skill markers are whole lines inside
    // lists, and a blank line the formatter adds around one reaches the
    // prompt (agent/lib/skills/catalog.ts).
    "agent/instructions/content/**",
  ],
  printWidth: 80,
  semi: true,
  singleQuote: false,
  sortPackageJson: false,
  sortTailwindcss: { stylesheet: "./app/globals.css" },
  tabWidth: 2,
  trailingComma: "es5",
  overrides: [
    {
      files: ["*.jsonc"],
      options: { trailingComma: "none" },
    },
  ],
};
