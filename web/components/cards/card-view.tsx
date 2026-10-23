import type { Card } from "@shared/cards/schema";

/** Placeholder until the renderer of the blocks lands. */
export function CardView({ card }: { readonly card: Card }) {
  return (
    <article>
      <h1>{card.title}</h1>
    </article>
  );
}
