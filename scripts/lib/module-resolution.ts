import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Node runs this repository's TypeScript directly with `--experimental-strip-types`,
 * but it resolves neither the `@db`/`@shared` path aliases nor the extensionless
 * relative imports the application sources use. Both are a `tsconfig.json`
 * contract that only bundlers honour, so a plain `node scripts/*.ts` run
 * installs them itself before it loads anything from the application.
 */
const repositoryRoot = new URL("../../", import.meta.url);

/** Mirrors `compilerOptions.paths`; a trailing slash marks a prefix mapping. */
const moduleAliases: readonly (readonly [string, string])[] = [
  ["@db", "db/index.ts"],
  ["@db/", "db/"],
  ["@shared/environment", "shared/environment/env.ts"],
  ["@shared/", "shared/"],
  ["@agent/", "agent/"],
  ["@app/", "app/"],
  ["@evals/", "evals/"],
  ["@tests/", "tests/"],
  ["@tools/", "tools/"],
  ["@web/", "web/"],
];

const sourceExtensions = /\.(?:ts|tsx|mts|cts)$/u;
const resolvedExtensions = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|node)$/u;

function aliasedUrl(specifier: string) {
  for (const [alias, target] of moduleAliases) {
    if (alias.endsWith("/")) {
      if (specifier.startsWith(alias)) {
        return new URL(
          `${target}${specifier.slice(alias.length)}`,
          repositoryRoot
        ).href;
      }
    } else if (specifier === alias) {
      return new URL(target, repositoryRoot).href;
    }
  }
  return undefined;
}

/** `./scope` means `./scope.ts` or `./scope/index.ts` in application sources. */
function withSourceExtension(url: string) {
  if (resolvedExtensions.test(url)) return url;
  return (
    [`${url}.ts`, `${url}.tsx`, `${url}/index.ts`].find((candidate) =>
      existsSync(fileURLToPath(candidate))
    ) ?? url
  );
}

/** True for a repository source file, as opposed to a published package. */
function isApplicationSource(url: string) {
  return sourceExtensions.test(url) && !url.includes("/node_modules/");
}

export function registerApplicationModuleResolution() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const aliased = aliasedUrl(specifier);
      if (aliased !== undefined) {
        return nextResolve(withSourceExtension(aliased), context);
      }

      const parentUrl = context.parentURL;
      // Only application sources get extension inference: a package's own
      // relative `require` must keep Node's CommonJS resolution.
      if (
        specifier.startsWith(".") &&
        parentUrl !== undefined &&
        isApplicationSource(parentUrl)
      ) {
        return nextResolve(
          withSourceExtension(new URL(specifier, parentUrl).href),
          context
        );
      }

      return nextResolve(specifier, context);
    },
  });
}
