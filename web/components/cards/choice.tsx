"use client";

import { Check } from "lucide-react";
import type { Card } from "@shared/cards/schema";
import { cn } from "@web/components/class-names";
import { initialValue, useCardAnswer } from "./answer";
import { Carousel } from "./carousel";
import { PhotoFrame } from "./photo-frame";
import { haptic } from "./telegram";

type Choice = Extract<Card["blocks"][number], { type: "choice" }>;
type Option = Choice["options"][number];

/** The dot of a radio or the tick of a checkbox, as the tile shows its input. */
function Marker({
  checked,
  className,
  multiple,
}: {
  readonly checked: boolean;
  readonly className?: string;
  readonly multiple: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center border-2 border-foreground",
        multiple ? "rounded-[6px]" : "rounded-full",
        className,
        checked && multiple && "bg-foreground text-background"
      )}
    >
      {checked &&
        (multiple ? (
          <Check className="size-3.5 stroke-3" />
        ) : (
          <span className="size-2.5 rounded-full bg-foreground" />
        ))}
    </span>
  );
}

/**
 * A choice of a card (`docs/cards.md`, «Как это выглядит» and «Фото в
 * карточках»): a fieldset whose legend is the question and whose options are
 * tiles — a radio for one answer, a checkbox for several. The native inputs
 * keep the keyboard (arrows within the radios, space to tick) and say the
 * state; the tile shows it: a 2 px ink border, the dot or the tick. As a
 * `list` the tiles stand in a column, the option's detail under its title and
 * its price on the right, with a thumbnail when the options have photos; as
 * `tiles` they stand two to a row and as a `carousel` in a strip to swipe,
 * each with its photo on top and the dot or the tick on the photo. A press
 * anywhere on a tile, its photo too, picks it. Once the card is answered or
 * cannot be by this viewer, the tiles only show what is chosen.
 */
export function ChoiceBlock({ block }: { readonly block: Choice }) {
  const answer = useCardAnswer();
  const value = answer.draft[block.id] ?? initialValue(block);
  const picked = new Set([value].flat());
  const locked = answer.viewer !== "open" || answer.sending !== undefined;
  const error = answer.errors[block.id];
  const errorId = `card-question-${block.id}-error`;
  const framed = block.layout !== "list";

  const tile = (option: Option, position: number) => {
    const checked = picked.has(option.value);
    return (
      <label
        className={cn(
          "group/tile relative flex w-full bg-card transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-foreground motion-reduce:transition-none",
          framed
            ? cn(
                "flex-col overflow-hidden rounded-lg border",
                checked
                  ? "border-foreground ring-1 ring-foreground"
                  : "border-bro-line"
              )
            : cn(
                "items-start gap-3 rounded-2xl",
                checked
                  ? "border-2 border-foreground p-[0.9375rem]"
                  : "border border-bro-line p-4"
              ),
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
        {framed && option.photo && (
          <PhotoFrame eager={position < 2} photo={option.photo} />
        )}
        <span
          className={cn(
            "flex min-w-0 flex-1 items-start gap-3",
            framed && "p-3"
          )}
        >
          <Marker
            checked={checked}
            className={cn(
              "mt-px",
              framed &&
                "bg-card group-has-[img]/tile:absolute group-has-[img]/tile:top-3 group-has-[img]/tile:left-3 group-has-[img]/tile:mt-0 group-has-[img]/tile:size-6"
            )}
            multiple={block.multiple}
          />
          {!framed && option.photo && (
            <PhotoFrame
              className="size-18 shrink-0 rounded-sm"
              photo={option.photo}
              ratio="square"
            />
          )}
          <span className="type-row flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-[600] wrap-anywhere">{option.title}</span>
            {framed && option.side && (
              <span className="font-[600] wrap-anywhere">{option.side}</span>
            )}
            {option.detail && (
              <span className="type-caption wrap-anywhere text-muted-foreground">
                {option.detail}
              </span>
            )}
          </span>
          {!framed && option.side && (
            <span className="type-row max-w-[40%] shrink-0 text-right wrap-anywhere">
              <span className="font-[600]">{option.side}</span>
            </span>
          )}
        </span>
      </label>
    );
  };

  return (
    <fieldset
      aria-describedby={error === undefined ? undefined : errorId}
      className="flex min-w-0 flex-col gap-2"
    >
      <legend className="type-cards-question mb-2 wrap-anywhere">
        {block.label}
      </legend>
      {block.layout === "list" && block.options.map(tile)}
      {block.layout === "tiles" && (
        <div className="grid grid-cols-2 gap-2">{block.options.map(tile)}</div>
      )}
      {block.layout === "carousel" && (
        <Carousel label={block.label} slideClassName="w-70 py-1">
          {block.options.map(tile)}
        </Carousel>
      )}
      {error !== undefined && (
        <p className="type-caption text-bro-error" id={errorId}>
          {error}
        </p>
      )}
    </fieldset>
  );
}
