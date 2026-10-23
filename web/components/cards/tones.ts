import type { Card } from "@shared/cards/schema";

/**
 * How each tone of a card is painted (docs/cards.md): `band` tints the strip
 * over the title and the dot by the kicker, `callout` the whole callout.
 */
export const toneStyles = {
  neutral: { band: "bg-bro-line", callout: "bg-background" },
  info: { band: "bg-bro-blue", callout: "bg-bro-blue" },
  success: {
    band: "bg-success-border",
    callout: "border border-success-border bg-success-subtle text-success",
  },
  warning: { band: "bg-bro-yellow", callout: "bg-bro-yellow" },
  danger: { band: "bg-bro-coral", callout: "bg-bro-coral text-bro-error" },
} as const satisfies Record<
  Card["tone"],
  { readonly band: string; readonly callout: string }
>;
