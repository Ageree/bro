"use client";

import { Check } from "lucide-react";
import type { Card } from "@shared/cards/schema";
import { cn } from "@web/components/class-names";
import { initialValue, useCardAnswer } from "./answer";
import { haptic } from "./telegram";

type Choice = Extract<Card["blocks"][number], { type: "choice" }>;

/**
 * A choice of a card (`docs/cards.md`, «Как это выглядит»): a fieldset whose
 * legend is the question and whose options are tiles — a radio for one
 * answer, a checkbox for several — with the option's detail under its title
 * and its price on the right. The native inputs keep the keyboard (arrows
 * within the radios, space to tick) and say the state; the tile shows it:
 * a 2 px ink border, the dot or the tick. Once the card is answered or
 * cannot be by this viewer, the tiles only show what is chosen.
 */
export function ChoiceBlock({ block }: { readonly block: Choice }) {
  const answer = useCardAnswer();
  const value = answer.draft[block.id] ?? initialValue(block);
  const picked = new Set([value].flat());
  const locked = answer.viewer !== "open" || answer.sending !== undefined;
  const error = answer.errors[block.id];
  const errorId = `card-question-${block.id}-error`;
  return (
    <fieldset
      aria-describedby={error === undefined ? undefined : errorId}
      className="flex min-w-0 flex-col gap-2"
    >
      <legend className="type-cards-question mb-2 wrap-anywhere">
        {block.label}
      </legend>
      {block.options.map((option, position) => {
        const checked = picked.has(option.value);
        return (
          <label
            className={cn(
              "flex items-start gap-3 rounded-2xl bg-card transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-foreground motion-reduce:transition-none",
              checked
                ? "border-2 border-foreground p-[0.9375rem]"
                : "border border-bro-line p-4",
              locked ? "cursor-default" : "cursor-pointer hover:bg-secondary"
            )}
            key={option.value}
          >
            <input
              aria-describedby={error === undefined ? undefined : errorId}
              aria-invalid={error === undefined ? undefined : true}
              checked={checked}
              className="sr-only"
              disabled={locked}
              id={position === 0 ? `card-question-${block.id}` : undefined}
              name={`card-${block.id}`}
              onChange={() => {
                haptic("selection");
                answer.touch(block.id);
                answer.set(
                  block.id,
                  block.multiple
                    ? block.options
                        .map((each) => each.value)
                        .filter((each) =>
                          each === option.value ? !checked : picked.has(each)
                        )
                    : option.value
                );
              }}
              type={block.multiple ? "checkbox" : "radio"}
              value={option.value}
            />
            <span
              aria-hidden
              className={cn(
                "mt-px flex size-5 shrink-0 items-center justify-center border-2 border-foreground",
                block.multiple ? "rounded-[6px]" : "rounded-full",
                checked && block.multiple && "bg-foreground text-background"
              )}
            >
              {checked &&
                (block.multiple ? (
                  <Check className="size-3.5 stroke-3" />
                ) : (
                  <span className="size-2.5 rounded-full bg-foreground" />
                ))}
            </span>
            <span className="type-row flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-[600] wrap-anywhere">{option.title}</span>
              {option.detail && (
                <span className="type-caption wrap-anywhere text-muted-foreground">
                  {option.detail}
                </span>
              )}
            </span>
            {option.side && (
              <span className="type-row max-w-[40%] shrink-0 text-right wrap-anywhere">
                <span className="font-[600]">{option.side}</span>
              </span>
            )}
          </label>
        );
      })}
      {error !== undefined && (
        <p className="type-caption text-bro-error" id={errorId}>
          {error}
        </p>
      )}
    </fieldset>
  );
}
