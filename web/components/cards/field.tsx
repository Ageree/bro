"use client";

import type { Card } from "@shared/cards/schema";
import { cn } from "@web/components/class-names";
import { Input } from "@web/components/ui/input";
import { Textarea } from "@web/components/ui/textarea";
import { Button } from "@web/components/ui/button";
import { Minus, Plus } from "lucide-react";
import { initialValue, useCardAnswer } from "./answer";

type Field = Extract<Card["blocks"][number], { type: "field" }>;

/** What the browser's own control is for each kind of field. */
const controls = {
  count: { inputMode: "decimal", type: "number" },
  date: { inputMode: undefined, type: "date" },
  longtext: { inputMode: undefined, type: "text" },
  number: { inputMode: "decimal", type: "text" },
  slider: { inputMode: undefined, type: "range" },
  text: { inputMode: undefined, type: "text" },
  time: { inputMode: undefined, type: "time" },
} as const satisfies Record<
  Field["input"],
  { readonly inputMode: "decimal" | undefined; readonly type: string }
>;

/**
 * A field of a card (`docs/cards.md`, «Как это выглядит»): the label over a
 * pill of 48 px with an ink border — a box of three lines with a radius of
 * 24 for `longtext` — the unit inside it on the right, the hint under it,
 * and an error in the ink-red under that, which the control names
 * (`aria-invalid`, `aria-describedby`). The error shows once a press of a
 * button found it, not as the field loses focus: text appearing above the
 * button then would move it from under the finger pressing it. A number is
 * typed as text, so «30 000» and «2,5» go in as people write them. Once the
 * card is answered or cannot be by this viewer, it only shows what is there.
 */
export function FieldBlock({ block }: { readonly block: Field }) {
  const answer = useCardAnswer();
  const value = [answer.draft[block.id] ?? initialValue(block)].flat().join("");
  const locked = answer.viewer !== "open" || answer.sending !== undefined;
  const error = answer.errors[block.id];
  const id = `card-question-${block.id}`;
  const described = [
    block.hint === undefined ? undefined : `${id}-hint`,
    error === undefined ? undefined : `${id}-error`,
  ].filter((each) => each !== undefined);
  const control = {
    "aria-describedby": described.length > 0 ? described.join(" ") : undefined,
    "aria-invalid": error === undefined ? undefined : true,
    id,
    placeholder: block.placeholder,
    readOnly: locked,
    required: block.required,
    value,
  };
  const border = error === undefined ? "border-foreground" : "border-bro-error";
  const number = Number(value);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label className="type-cards-question wrap-anywhere" htmlFor={id}>
        {block.label}
      </label>
      {block.input === "count" ? (
        <div className="flex items-center gap-4" id={id} tabIndex={-1}>
          <Button
            aria-label={`Уменьшить: ${block.label}`}
            disabled={locked || number <= (block.min ?? 0)}
            size="icon"
            variant="outline"
            onClick={() => {
              answer.set(
                block.id,
                String(Math.max(block.min ?? 0, number - (block.step ?? 1)))
              );
            }}
          >
            <Minus />
          </Button>
          <output className="type-row min-w-12 text-center" aria-live="polite">
            {value}
            {block.unit ? ` ${block.unit}` : ""}
          </output>
          <Button
            aria-label={`Увеличить: ${block.label}`}
            disabled={locked || number >= (block.max ?? 0)}
            size="icon"
            variant="outline"
            onClick={() => {
              answer.set(
                block.id,
                String(Math.min(block.max ?? 0, number + (block.step ?? 1)))
              );
            }}
          >
            <Plus />
          </Button>
        </div>
      ) : block.input === "slider" ? (
        <div className="flex flex-col gap-2">
          <output className="type-row" htmlFor={id}>
            {new Intl.NumberFormat("ru-RU").format(number)} {block.unit}
          </output>
          <Input
            {...control}
            className="h-11 w-full cursor-pointer accent-foreground"
            disabled={locked}
            type="range"
            variant="plain"
            min={block.min}
            max={block.max}
            step={block.step ?? 1}
            onChange={(event) => {
              answer.set(block.id, event.target.value);
            }}
          />
          <div className="flex justify-between type-caption text-muted-foreground">
            <span>{block.min}</span>
            <span>{block.max}</span>
          </div>
        </div>
      ) : block.input === "longtext" ? (
        <Textarea
          {...control}
          className={cn(
            "min-h-24 resize-none rounded-3xl px-5 py-3 type-row text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground",
            border,
            locked && "focus-visible:outline-none"
          )}
          maxLength={1000}
          onChange={(event) => {
            answer.set(block.id, event.target.value);
          }}
          rows={3}
        />
      ) : (
        <div
          className={cn(
            "flex h-12 items-center gap-2 rounded-full border-2 bg-card px-5 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-foreground",
            border
          )}
        >
          <Input
            {...control}
            className="type-row h-full flex-1 text-foreground"
            inputMode={controls[block.input].inputMode}
            maxLength={block.input === "text" ? 200 : 32}
            onChange={(event) => {
              answer.set(block.id, event.target.value);
            }}
            type={controls[block.input].type}
            variant="plain"
          />
          {block.unit && (
            <span className="type-row shrink-0 text-muted-foreground">
              {block.unit}
            </span>
          )}
        </div>
      )}
      {block.hint !== undefined && (
        <p className="type-caption text-muted-foreground" id={`${id}-hint`}>
          {block.hint}
        </p>
      )}
      {error !== undefined && (
        <p className="type-caption text-bro-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
