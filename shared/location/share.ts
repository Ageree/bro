/**
 * The message the web chat's «поделиться геопозицией» button sends right
 * after the point is stored (`web/trpc/router.ts`, `location.share`): the
 * web channel reads it as the person's own shared point
 * (`agent/lib/location/context.ts`).
 */
export const webShareText = "📍 Моя геопозиция";
