import type { Card } from "@shared/cards/schema";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@web/components/class-names";
import { Badge } from "@web/components/ui/badge";
import { CardLink } from "./card-link";
import { Carousel } from "./carousel";
import { Copyable } from "./copyable";
import { GalleryBlock } from "./gallery";
import { PhotoFrame } from "./photo-frame";
import { toneStyles } from "./tones";

type Block = Card["blocks"][number];
type BlockOf<Type extends Block["type"]> = Extract<Block, { type: Type }>;
type Chip = BlockOf<"chips">["items"][number];

const chipColors = {
  neutral: "bg-secondary",
  blue: "bg-bro-blue",
  yellow: "bg-bro-yellow",
  pink: "bg-bro-pink",
  coral: "bg-bro-coral",
} as const satisfies Record<Chip["color"], string>;

const stepStates = {
  done: "Выполнено: ",
  current: "Сейчас: ",
  upcoming: "Дальше: ",
} as const satisfies Record<
  BlockOf<"timeline">["steps"][number]["state"],
  string
>;

function ChipView({
  chip,
  className,
}: {
  readonly chip: Chip;
  readonly className?: string;
}) {
  return (
    <Badge
      className={cn(
        "h-auto min-h-6 px-3 py-1 type-cards-label whitespace-normal text-foreground wrap-anywhere",
        chipColors[chip.color],
        className
      )}
      variant="secondary"
    >
      {chip.text}
    </Badge>
  );
}

function FactsBlock({ block }: { readonly block: BlockOf<"facts"> }) {
  return (
    <dl className="flex flex-col">
      {block.rows.map((row) => (
        <div
          className="flex items-baseline justify-between gap-4 border-t border-bro-line py-3 first:border-t-0 first:pt-0 last:pb-0"
          key={row.label}
        >
          <dt className="type-row max-w-[45%] shrink-0 wrap-anywhere text-muted-foreground">
            {row.label}
          </dt>
          <dd className="type-row min-w-0 text-right wrap-anywhere">
            {row.strong ? (
              <strong className="font-[600]">{row.value}</strong>
            ) : (
              row.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StatBlock({ block }: { readonly block: BlockOf<"stat"> }) {
  return (
    <dl className="flex flex-col gap-1">
      <dt className="type-caption text-muted-foreground">{block.label}</dt>
      <dd className="type-cards-value wrap-anywhere">{block.value}</dd>
      {block.hint && (
        <dd className="type-row wrap-anywhere text-muted-foreground">
          {block.hint}
        </dd>
      )}
    </dl>
  );
}

/**
 * Options as cards in a strip (`layout: "carousel"`): a 4:3 photo on top, the
 * title, the price, the detail and the chip under it, the next card peeking
 * in. A card with an address is a link as a whole.
 */
function ListCarousel({ block }: { readonly block: BlockOf<"list"> }) {
  return (
    <Carousel label="Варианты" slideClassName="w-70">
      {block.rows.map((row, position) => {
        const content = (
          <>
            {row.photo && <PhotoFrame eager={position < 2} photo={row.photo} />}
            <span className="type-row flex flex-1 flex-col gap-1 p-4">
              <span className="font-[600] wrap-anywhere">{row.title}</span>
              {row.side && (
                <span className="font-[600] wrap-anywhere">{row.side}</span>
              )}
              {row.subtitle && (
                <span className="type-caption wrap-anywhere text-muted-foreground">
                  {row.subtitle}
                </span>
              )}
              {row.chip && (
                <ChipView chip={row.chip} className="mt-1.5 self-start" />
              )}
              {row.photo?.credit && (
                <span className="mt-auto pt-2 type-caption wrap-anywhere text-muted-foreground">
                  Фото: {row.photo.credit}
                </span>
              )}
            </span>
          </>
        );
        const card =
          "flex w-full flex-col overflow-hidden rounded-lg border border-bro-line bg-card";
        return row.href ? (
          <CardLink
            className={cn(
              card,
              "transition-colors outline-none hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground motion-reduce:transition-none"
            )}
            href={row.href}
            key={row.title}
          >
            {content}
          </CardLink>
        ) : (
          <div className={card} key={row.title}>
            {content}
          </div>
        );
      })}
    </Carousel>
  );
}

function ListBlock({ block }: { readonly block: BlockOf<"list"> }) {
  if (block.layout === "carousel") return <ListCarousel block={block} />;
  return (
    <ul className="-my-3 flex flex-col">
      {block.rows.map((row) => {
        const content = (
          <>
            {row.photo && (
              <PhotoFrame
                className="size-18 shrink-0 rounded-sm"
                photo={row.photo}
                ratio="square"
              />
            )}
            <span className="type-row flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-[600] wrap-anywhere">{row.title}</span>
              {row.subtitle && (
                <span className="type-caption wrap-anywhere text-muted-foreground">
                  {row.subtitle}
                </span>
              )}
              {row.chip && (
                <ChipView chip={row.chip} className="mt-1.5 self-start" />
              )}
            </span>
            {row.side && (
              <span className="type-row max-w-[40%] shrink-0 text-right wrap-anywhere">
                <span className="font-[600]">{row.side}</span>
              </span>
            )}
            {row.href && (
              <ChevronRight
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
            )}
          </>
        );
        return (
          <li
            className="border-t border-bro-line first:border-t-0"
            key={row.title}
          >
            {row.href ? (
              <CardLink
                className="-mx-3 flex items-start gap-3 rounded-lg p-3 transition-colors outline-none hover:bg-secondary focus-visible:outline-2 focus-visible:outline-foreground motion-reduce:transition-none"
                href={row.href}
              >
                {content}
              </CardLink>
            ) : (
              <div className="flex items-start gap-3 py-3">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TimelineBlock({ block }: { readonly block: BlockOf<"timeline"> }) {
  return (
    <ol className="flex flex-col">
      {block.steps.map((step, position) => {
        const last = position === block.steps.length - 1;
        return (
          <li
            aria-current={step.state === "current" ? "step" : undefined}
            className="flex gap-3"
            key={`${step.time ?? ""}${step.title}`}
          >
            <span
              aria-hidden
              className="flex w-4 shrink-0 flex-col items-center"
            >
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2",
                  step.state === "done" &&
                    "border-foreground bg-foreground text-background",
                  step.state === "current" &&
                    "border-4 border-foreground bg-card group-data-[tone=danger]/card:border-bro-error",
                  step.state === "upcoming" && "border-muted-foreground bg-card"
                )}
              >
                {step.state === "done" && (
                  <Check className="size-2.5 stroke-3" />
                )}
              </span>
              {!last && (
                <span
                  className={cn(
                    "w-px flex-1",
                    step.state === "done" ? "bg-foreground" : "bg-bro-line"
                  )}
                />
              )}
            </span>
            <div
              className={cn(
                "type-row flex min-w-0 flex-1 flex-col",
                !last && "pb-5"
              )}
            >
              {step.time && (
                <span className="type-caption wrap-anywhere text-muted-foreground">
                  {step.time}
                </span>
              )}
              <span className="font-[600] wrap-anywhere">
                <span className="sr-only">{stepStates[step.state]}</span>
                {step.title}
              </span>
              {step.detail && (
                <span className="wrap-anywhere text-muted-foreground">
                  {step.detail}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Stop({
  label,
  right = false,
  stop,
}: {
  readonly label: string;
  readonly right?: boolean;
  readonly stop: BlockOf<"route">["from"];
}) {
  return (
    <div
      className={cn(
        "type-row flex min-w-0 flex-col",
        right && "items-end text-right"
      )}
    >
      <span className="sr-only">{label}</span>
      {stop.time && (
        <span className="type-cards-time wrap-anywhere">{stop.time}</span>
      )}
      {stop.code && (
        <span className="font-[600] tracking-[0.08em] wrap-anywhere">
          {stop.code}
        </span>
      )}
      <span className="wrap-anywhere text-muted-foreground">{stop.place}</span>
      {stop.note && (
        <span className="type-caption wrap-anywhere text-muted-foreground">
          {stop.note}
        </span>
      )}
    </div>
  );
}

function RouteBlock({ block }: { readonly block: BlockOf<"route"> }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)] items-start gap-x-2">
        <Stop label="Откуда: " stop={block.from} />
        <span aria-hidden className="flex h-9 items-center">
          <span className="size-1.5 shrink-0 rounded-full bg-foreground" />
          <span className="h-px flex-1 bg-foreground" />
          <span className="size-1.5 shrink-0 rounded-full bg-foreground" />
        </span>
        <Stop label="Куда: " right stop={block.to} />
      </div>
      {block.meta && (
        <p className="text-center type-caption wrap-anywhere text-muted-foreground">
          {block.meta}
        </p>
      )}
    </div>
  );
}

function TableBlock({ block }: { readonly block: BlockOf<"table"> }) {
  return (
    <div className="overflow-x-auto">
      <table className="type-row w-full border-separate border-spacing-0">
        <thead>
          <tr>
            {block.columns.map((column, position) => (
              <th
                className={cn(
                  "border-b border-bro-line px-2 pb-2 text-left align-bottom type-cards-label text-muted-foreground",
                  position === 0
                    ? "sticky left-0 z-10 bg-card"
                    : "whitespace-nowrap"
                )}
                key={column}
                scope="col"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowPosition) => {
            const highlighted = block.highlight === rowPosition;
            return (
              <tr key={row.join("|")}>
                {row.map((cell, position) => {
                  const cellClass = cn(
                    "border-b border-bro-line px-2 py-3 text-left align-top",
                    rowPosition === block.rows.length - 1 && "border-b-0",
                    highlighted
                      ? "border-transparent bg-bro-yellow font-[600] shadow-[1px_0_0_var(--color-bro-yellow)] first:rounded-l-lg last:rounded-r-lg last:shadow-none"
                      : "font-normal"
                  );
                  return position === 0 ? (
                    <th
                      className={cn(
                        cellClass,
                        "sticky left-0 z-10 max-w-40 min-w-20 wrap-break-word",
                        !highlighted && "bg-card"
                      )}
                      key={block.columns[position]}
                      scope="row"
                    >
                      {highlighted && (
                        <span className="sr-only">Выбрано: </span>
                      )}
                      {cell}
                    </th>
                  ) : (
                    <td
                      className={cn(cellClass, "whitespace-nowrap")}
                      key={block.columns[position]}
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CalloutBlock({ block }: { readonly block: BlockOf<"callout"> }) {
  return (
    <div
      className={cn(
        "type-row flex flex-col gap-1 rounded-lg p-4",
        toneStyles[block.tone].callout
      )}
      role="note"
    >
      {block.title && <p className="font-[600] wrap-anywhere">{block.title}</p>}
      <p className="wrap-anywhere whitespace-pre-line">{block.text}</p>
    </div>
  );
}

function ChecklistBlock({ block }: { readonly block: BlockOf<"checklist"> }) {
  return (
    <ul className="flex flex-col gap-2">
      {block.items.map((item) => (
        <li key={item.text}>
          <label className="flex items-start gap-3">
            <input
              checked={item.done}
              className="peer sr-only"
              disabled
              readOnly
              type="checkbox"
            />
            <span
              aria-hidden
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border-2 border-foreground text-background peer-checked:bg-foreground [&>svg]:invisible peer-checked:[&>svg]:visible"
            >
              <Check className="size-3.5 stroke-3" />
            </span>
            <span
              className={cn(
                "type-row wrap-anywhere",
                item.done && "text-muted-foreground line-through"
              )}
            >
              {item.text}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/**
 * One photo across the plate, with its caption and the site it came from. A
 * photo that does not load takes the whole figure with it.
 */
function ImageBlock({ block }: { readonly block: BlockOf<"image"> }) {
  return (
    <figure className="flex flex-col gap-2 not-has-[img]:hidden">
      <PhotoFrame className="rounded-lg" photo={block} />
      {(block.caption ?? block.credit) && (
        <figcaption className="type-caption wrap-anywhere text-muted-foreground">
          {block.caption}
          {block.caption && block.credit && " · "}
          {block.credit && `Фото: ${block.credit}`}
        </figcaption>
      )}
    </figure>
  );
}

/** One block of a card, set the way `docs/cards.md` describes it. */
export function BlockView({ block }: { readonly block: Block }) {
  switch (block.type) {
    case "heading":
      return <h2 className="type-cards-section wrap-anywhere">{block.text}</h2>;
    case "text":
      return (
        <p
          className={cn(
            "wrap-anywhere whitespace-pre-line",
            block.muted
              ? "type-caption text-muted-foreground"
              : "type-scale-body"
          )}
        >
          {block.text}
        </p>
      );
    case "facts":
      return <FactsBlock block={block} />;
    case "stat":
      return <StatBlock block={block} />;
    case "list":
      return <ListBlock block={block} />;
    case "timeline":
      return <TimelineBlock block={block} />;
    case "route":
      return <RouteBlock block={block} />;
    case "table":
      return <TableBlock block={block} />;
    case "callout":
      return <CalloutBlock block={block} />;
    case "chips":
      return (
        <ul className="flex flex-wrap gap-2">
          {block.items.map((chip) => (
            <li key={chip.text}>
              <ChipView chip={chip} />
            </li>
          ))}
        </ul>
      );
    case "checklist":
      return <ChecklistBlock block={block} />;
    case "image":
      return <ImageBlock block={block} />;
    case "gallery":
      return <GalleryBlock block={block} />;
    case "copyable":
      return <Copyable label={block.label} value={block.value} />;
    case "divider":
      return <hr className="my-1 border-bro-line" />;
  }
  return null;
}
