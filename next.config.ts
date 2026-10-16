import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  // The e2e suite serves `next dev` on 127.0.0.1 (a free port takes no
  // `localhost`), and Next.js blocks its dev scripts on any other origin:
  // the page would never hydrate (docs/e2e.md).
  allowedDevOrigins: ["127.0.0.1"],
  // The dev badge sits in the bottom-left corner over «Выйти» at the foot of
  // the rail and takes its taps; build errors still open the overlay.
  devIndicators: false,
  logging: {
    incomingRequests: {
      ignore: [
        /\/api\/personal-mail\/[^/?]+\/callback(?:\?|$)/u,
        /\/api\/yoomoney\/callback(?:\?|$)/u,
        // A card payment's link carries its secret in the query.
        /\/pay\/[^/?]+(?:\?|$)/u,
        /\/api\/yoomoney\/pay\//u,
      ],
    },
  },
  serverExternalPackages: ["supermemory"],
  // The sign-in window shows a page of the person's own browser: no other
  // page may frame it, and its address is not sent on to anyone.
  async headers() {
    return [
      {
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
        source: "/handoff/:path*",
      },
      {
        // `strict-origin`: the link's secret in the address never leaves the
        // page, and its forms carry the site's origin — under `no-referrer`
        // (or `same-origin`, for the bank's form) a browser sends
        // `Origin: null`, and «Оплатить» checks it.
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "strict-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
        source: "/pay/:path*",
      },
    ];
  },
};

// The Cloud.ru VM gets the app as an artifact and runs no package manager:
// its build sets NEXT_OUTPUT=standalone (scripts/cloudru-app-host). Vercel
// builds leave it unset and stay as they were.
// oxlint-disable-next-line eslint/no-restricted-properties -- a build switch read before any env module; validating the app's runtime env here would break `next typegen` without it
if (process.env.NEXT_OUTPUT === "standalone") nextConfig.output = "standalone";

// In `next dev` eve's routes go through `proxy.ts`, which buffers 10 MB of a
// body and passes the rest on cut short, so a web message with files beyond
// that reached eve as broken JSON. On the VM `/eve/*` bypasses Next, and a
// global 64 MB would let bro-web buffer that much for any public route.
export default withEve((phase: string) =>
  phase === PHASE_DEVELOPMENT_SERVER
    ? { ...nextConfig, experimental: { proxyClientMaxBodySize: "64mb" } }
    : nextConfig
);
