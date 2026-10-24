"use client";

import type { Card } from "@shared/cards/schema";
import { useCardAnswer } from "./answer";
import { cn } from "@web/components/class-names";
import { Badge } from "@web/components/ui/badge";
import { buttonVariants } from "@web/components/ui/button";
import { BlockView } from "./blocks";
import { CardLink } from "./card-link";
import { AnswerStatus, SubmitButton } from "./submit";
import { toneStyles } from "./tones";

/**
 * A card as the page shows it: one white plate with a strip of the card's
 * tone over the title, the blocks in a column, the buttons and the fine
 * print. Everything on it is text and data, and its questions and submit
 * buttons answer through the page's `CardAnswerScope`; the plate fills the
 * width the page gives it. An updated card says so by its title.
 */
export function CardView({
  card: sentCard,
  updated: sentUpdated = false,
}: {
  readonly card: Card;
  readonly updated?: boolean;
}) {
  const answer = useCardAnswer();
  const card = answer.card ?? sentCard;
  const updated = sentUpdated || (answer.revision ?? 1) > 1;
  const asks = card.actions.some(
    (action) => "submit" in action || "intent" in action
  );
  return (
    <article
      className="group/card w-full overflow-hidden bro-plate"
      data-tone={card.tone}
    >
      <div aria-hidden className={cn("h-2.5", toneStyles[card.tone].band)} />
      <div className="flex flex-col gap-4 p-6">
        <header className="flex flex-col gap-2">
          {(card.kicker !== undefined || updated) && (
            <div className="flex flex-wrap items-center gap-2">
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
              {updated && (
                <Badge className="type-cards-label" variant="outline">
                  Обновлено
                </Badge>
              )}
            </div>
          )}
          <h1 className="type-cards-title wrap-anywhere">{card.title}</h1>
          {card.subtitle && (
            <p className="type-scale-body wrap-anywhere text-muted-foreground">
              {card.subtitle}
            </p>
          )}
        </header>
        {card.note && (
          <output className="type-row rounded-2xl bg-bro-blue/30 p-4">
            {card.note}
          </output>
        )}
        {card.blocks.map((block, position) => (
          <div
            className="relative min-w-0"
            key={`${block.type}-${String(position)}`}
          >
            <BlockView block={block} />
            {answer.changed?.has(position) && (
              <span
                aria-hidden
                key={`${String(answer.revision)}:${String(position)}`}
                className="pointer-events-none absolute inset-0 rounded-2xl bg-bro-yellow opacity-0 motion-safe:animate-pulse motion-safe:[animation-duration:900ms] motion-safe:[animation-iteration-count:1]"
              />
            )}
          </div>
        ))}
        {card.actions.length > 0 && (
          <div className="flex flex-col gap-3 pt-2">
            {card.actions.map((action) =>
              "href" in action ? (
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
              ) : (
                <SubmitButton
                  action={action}
                  key={"submit" in action ? action.submit : action.intent}
                />
              )
            )}
          </div>
        )}
        {asks && <AnswerStatus />}
        {card.footnote && (
          <p className="type-caption wrap-anywhere whitespace-pre-line text-muted-foreground">
            {card.footnote}
          </p>
        )}
      </div>
    </article>
  );
}
