import type { NextConfig } from "next";
import { withEve } from "eve/next";
import { publishEveChannelRoutes } from "./eve-channel-routes";

const nextConfig: NextConfig = {};

const withEveConfig = withEve(nextConfig);

// `withEve` writes the Vercel Build Output routes for `/eve/v1/*` while it
// resolves this config. The custom channel routes join that same generated
// config, right after it, so every agent route leaves the build together.
export default async function config(
  ...args: Parameters<typeof withEveConfig>
) {
  const resolved = await withEveConfig(...args);
  await publishEveChannelRoutes();
  return resolved;
}
