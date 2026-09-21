import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["supermemory"],
};

export default withEve(nextConfig);
