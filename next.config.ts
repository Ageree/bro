import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  // The e2e suite serves `next dev` on 127.0.0.1 (a free port takes no
  // `localhost`), and Next.js blocks its dev scripts on any other origin:
  // the page would never hydrate (docs/e2e.md).
  allowedDevOrigins: ["127.0.0.1"],
  // The dev badge sits in the bottom-left corner over «Выйти» at the foot of
  // the rail and takes its taps; build errors still open the overlay.
  devIndicators: false,
  serverExternalPackages: ["supermemory"],
};

export default withEve(nextConfig);
