import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * Public paths of the custom channel routes declared under `agent/channels`.
 *
 * `withEve` publishes only the framework-owned `/eve/v1/*` namespace to the
 * generated eve Vercel service, so a custom channel route reaches the Next.js
 * app instead of the agent unless the deployment routes it explicitly. The
 * colocated test fails when a channel declares a route this list is missing.
 */
export const eveChannelRoutePaths = [
  "/internal/scheduled-run/report",
  "/internal/scheduled-run/respond",
  "/webhooks/browser-use",
];

const vercelRouteSchema = z.looseObject({
  handle: z.string().optional(),
  src: z.string().optional(),
});

const vercelOutputConfigSchema = z.looseObject({
  routes: z.array(vercelRouteSchema).optional(),
  services: z
    .record(z.string(), z.looseObject({ framework: z.string().optional() }))
    .optional(),
});

/**
 * Routes every custom channel path to the generated eve service, the way eve
 * routes its own transport: one exact-match route per path, inserted ahead of
 * the filesystem handler so neither a Next.js page nor the proxy answers
 * first. Re-running the insertion replaces the routes it published before.
 */
export function insertEveChannelRoutes(
  routes: z.infer<typeof vercelRouteSchema>[],
  service: string
) {
  const published = eveChannelRoutePaths.map((path) => ({
    destination: { service, type: "service" },
    src: `^${escapeRouteLiteral(path)}$`,
  }));
  const sources = new Set(published.map((route) => route.src));
  const kept = routes.filter(
    (route) => route.src === undefined || !sources.has(route.src)
  );
  const filesystem = kept.findIndex((route) => route.handle === "filesystem");
  return filesystem < 0
    ? [...published, ...kept]
    : [...kept.slice(0, filesystem), ...published, ...kept.slice(filesystem)];
}

/**
 * Adds the custom channel routes to the Vercel Build Output config `withEve`
 * generates. Only a Vercel build writes that config, so a build that produces
 * none has nothing to publish and nothing to route.
 */
export async function publishEveChannelRoutes(projectRoot = process.cwd()) {
  const configPath = await resolveVercelOutputConfigPath(projectRoot);
  const file = await readOptionalFile(configPath);
  if (file === undefined) return;
  const config = vercelOutputConfigSchema.parse(JSON.parse(file));
  const services = Object.entries(config.services ?? {});
  if (services.length === 0) return;
  const service = services.find(([, entry]) => entry.framework === "eve");
  if (!service) {
    throw new Error(
      `${configPath} declares services but no eve service, so the custom channel routes have nowhere to go.`
    );
  }
  const published = {
    ...config,
    routes: insertEveChannelRoutes(config.routes ?? [], service[0]),
  };
  if (JSON.stringify(config) === JSON.stringify(published)) return;
  await writeFile(configPath, `${JSON.stringify(published, null, 2)}\n`);
}

// The same lookup `eve/next` performs before it writes the config: a Vercel
// build owns an output directory above the repository, while a local build
// writes next to the linked project.
async function resolveVercelOutputConfigPath(projectRoot: string) {
  const buildOutput = await findClosestDirectory(
    projectRoot,
    "output",
    "builds.json"
  );
  if (buildOutput) return join(buildOutput, "config.json");
  const linked = await findClosestDirectory(
    projectRoot,
    ".vercel",
    "project.json"
  );
  return join(linked ?? join(projectRoot, ".vercel"), "output", "config.json");
}

async function findClosestDirectory(
  start: string,
  directoryName: string,
  fileName: string
): Promise<string | undefined> {
  const candidate = join(start, directoryName);
  if (await isFile(join(candidate, fileName))) return candidate;
  const parent = dirname(start);
  if (parent === start) return undefined;
  return findClosestDirectory(parent, directoryName, fileName);
}

async function readOptionalFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function escapeRouteLiteral(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}
