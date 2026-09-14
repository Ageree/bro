import { v } from "convex/values";
import { internalAction } from "./_generated/server";

/**
 * Every few minutes: ping the eve app so its Vercel instance, the cached
 * Photon/Spectrum client and the OpenRouter connection stay warm. A cold
 * instance pays bundle load + Photon token boot before the first bubble.
 */
export const pingEve = internalAction({
  args: {},
  returns: v.null(),
  handler: async () => {
    const eveUrl = process.env.EVE_URL;
    // ponytail: no EVE_URL on this deployment → silent no-op
    if (!eveUrl) return null;
    const secret = process.env.BRO_INTERNAL_SECRET ?? "";
    try {
      const res = await fetch(`${eveUrl}/internal/warm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) console.error("warm ping failed", res.status);
    } catch (err) {
      console.error("warm ping failed", err);
    }
    return null;
  },
});
