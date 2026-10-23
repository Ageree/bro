import type { Card } from "@shared/cards/schema";
import { cn } from "@web/components/class-names";
import { buttonVariants } from "@web/components/ui/button";
import { BlockView } from "./blocks";
import { CardLink } from "./card-link";
import { toneStyles } from "./tones";

/**
 * A card as the page shows it: one white plate with a strip of the card's
 * tone over the title, the blocks in a column, the buttons and the fine
 * print. Everything on it is text and data; the plate is 30 rem wide at most
 * and fills a phone's width less a margin of 16 px.
 */
export function CardView({ card }: { readonly card: Card }) {
  return (
    <article
      className="group/card mx-auto my-4 w-[calc(100%-2rem)] max-w-[30rem] overflow-hidden bro-plate"
      data-tone={card.tone}
    >
      <div aria-hidden className={cn("h-2.5", toneStyles[card.tone].band)} />
      <div className="flex flex-col gap-4 p-6">
        <header className="flex flex-col gap-2">
          {card.kicker && (
            <p className="type-cards-kicker flex items-center gap-2 text-muted-foreground">
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full border border-foreground",
                  toneStyles[card.tone].band
                )}
              />
              <span className="wrap-anywhere">{card.kicker}</span>
            </p>
          )}
          <h1 className="type-cards-title wrap-anywhere">{card.title}</h1>
          {card.subtitle && (
            <p className="type-scale-body wrap-anywhere text-muted-foreground">
              {card.subtitle}
            </p>
          )}
        </header>
        {card.blocks.map((block, position) => (
          <BlockView block={block} key={`${block.type}-${String(position)}`} />
        ))}
        {card.actions.length > 0 && (
          <div className="flex flex-col gap-3 pt-2">
            {card.actions.map((action) => (
              <CardLink
                className={buttonVariants({
                  className: "w-full",
                  size: "paper",
                  variant: action.primary ? "paper" : "outline",
                })}
                href={action.href}
                key={action.href}
              >
                {action.label}
              </CardLink>
            ))}
          </div>
        )}
        {card.footnote && (
          <p className="type-caption wrap-anywhere whitespace-pre-line text-muted-foreground">
            {card.footnote}
          </p>
        )}
      </div>
    </article>
  );
}
