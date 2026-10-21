import type { MetadataRoute } from "next";
import { applicationOrigin } from "@shared/environment/origin";

/**
 * Read per request: a release is built with a stub `BETTER_AUTH_URL`
 * (`STUB_ENV` in `scripts/cloudru-app-host/host.py`), so a prerendered file
 * would name 127.0.0.1 in its `Sitemap` line.
 */
export const dynamic = "force-dynamic";

// The signed-in application, the agent's own routes and the pages opened from
// a link in a chat. The landing is the only page a search should list, and
// `/oferta` and `/privacy` say `noindex` themselves.
const privateSections = [
  "/workspace",
  "/chat",
  "/talk",
  "/api",
  "/eve",
  "/handoff",
  "/pay",
  "/yoomoney",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { allow: "/", disallow: privateSections, userAgent: "*" },
    sitemap: `${applicationOrigin()}/sitemap.xml`,
  };
}
