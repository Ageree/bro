import type { MetadataRoute } from "next";
import { applicationOrigin } from "@shared/environment/origin";

/** Per request, like `robots.ts`: the build's origin is a stub. */
export const dynamic = "force-dynamic";

/**
 * Only the landing. `/oferta` and `/privacy` are `noindex`, `/sign-in` is a
 * form, and the rest sits behind sign-in.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${applicationOrigin()}/` }];
}
