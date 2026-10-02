import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["supermemory"],
};

// The Cloud.ru VM gets the app as an artifact and runs no package manager:
// its build sets NEXT_OUTPUT=standalone (scripts/cloudru-app-host). Vercel
// builds leave it unset and stay as they were.
// oxlint-disable-next-line eslint/no-restricted-properties -- a build switch read before any env module; validating the app's runtime env here would break `next typegen` without it
if (process.env.NEXT_OUTPUT === "standalone") nextConfig.output = "standalone";

export default withEve(nextConfig);
