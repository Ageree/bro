"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Children, type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@web/components/class-names";
import { Button } from "@web/components/ui/button";
import { haptic } from "./telegram";

/** How long the strip rests before its slide counts as the one shown. */
const settleMs = 90;

/**
 * Where the strip lies: inside a card's plate it runs out to the plate's edges
 * (the plate's 24 px padding), so the next slide peeks in from the border; on
 * the full screen of the photo viewer a slide is the screen.
 */
const strips = {
  plate: "-mx-6 gap-3 scroll-px-6 px-6",
  screen: "h-full",
} as const;

/**
 * A strip of slides a finger swipes through, one at a time: each snaps to the
 * start with the next one peeking in, and nothing moves on its own. The strip
 * steps with the arrow keys (Home and End go to the ends) and, for a mouse,
 * with the round buttons over it; `counter` adds «2 / 5» and a dot per slide
 * under it. Inside Telegram a change of slide ticks the phone's haptics.
 * `slideClassName` sizes a slide (`w-70` for an option, nearly the full width
 * for a photo); `onIndexChange` hears of the slide shown, and `initialIndex`
 * opens on one.
 */
/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- a strip that scrolls takes focus, so a keyboard can scroll it (WCAG 2.1.1) */
export function Carousel({
  children,
  counter = false,
  initialIndex = 0,
  label,
  onIndexChange,
  slideClassName,
  variant = "plate",
}: {
  readonly children: ReactNode;
  readonly counter?: boolean;
  readonly initialIndex?: number;
  readonly label: string;
  readonly onIndexChange?: (index: number) => void;
  readonly slideClassName: string;
  readonly variant?: keyof typeof strips;
}) {
  const count = Children.count(children);
  const strip = useRef<HTMLUListElement>(null);
  const settling = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [shownIndex, setShownIndex] = useState(initialIndex);
  const shown = useRef(initialIndex);
  const index = Math.min(shownIndex, count - 1);

  useEffect(() => {
    const list = strip.current;
    const first = list?.children[0];
    const slide = list?.children[initialIndex];
    if (list && first instanceof HTMLElement && slide instanceof HTMLElement) {
      list.scrollLeft = slide.offsetLeft - first.offsetLeft;
    }
  }, [initialIndex]);

  useEffect(
    () => () => {
      clearTimeout(settling.current);
    },
    []
  );

  const offsets = () =>
    [...(strip.current?.children ?? [])].flatMap((slide, position, all) => {
      const first = all[0];
      return slide instanceof HTMLElement && first instanceof HTMLElement
        ? [{ offset: slide.offsetLeft - first.offsetLeft, position }]
        : [];
    });

  const show = (next: number) => {
    if (next === shown.current) return;
    shown.current = next;
    setShownIndex(next);
    onIndexChange?.(next);
    haptic("selection");
  };

  const go = (target: number) => {
    const next = Math.min(Math.max(target, 0), count - 1);
    const offset = offsets().find(({ position }) => position === next)?.offset;
    if (offset !== undefined) {
      strip.current?.scrollTo({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        left: offset,
      });
    }
    show(next);
  };

  const settle = () => {
    clearTimeout(settling.current);
    settling.current = setTimeout(() => {
      const left = strip.current?.scrollLeft ?? 0;
      const nearest = offsets().reduce<
        { distance: number; position: number } | undefined
      >((best, { offset, position }) => {
        const distance = Math.abs(offset - left);
        return best && best.distance <= distance
          ? best
          : { distance, position };
      }, undefined);
      if (nearest) show(nearest.position);
    }, settleMs);
  };

  return (
    <section
      aria-label={label}
      aria-roledescription="карусель"
      className={cn("flex flex-col gap-3", variant === "screen" && "h-full")}
    >
      <div className={cn("relative", variant === "screen" && "min-h-0 flex-1")}>
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the strip takes the keys that scroll it */}
        <ul
          className={cn(
            "relative flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-inset [&::-webkit-scrollbar]:hidden",
            strips[variant]
          )}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            const target =
              event.key === "ArrowLeft"
                ? index - 1
                : event.key === "ArrowRight"
                  ? index + 1
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? count - 1
                      : undefined;
            if (target === undefined) return;
            event.preventDefault();
            go(target);
          }}
          onScroll={settle}
          ref={strip}
          tabIndex={0}
        >
          {Children.map(children, (slide) => (
            <li className={cn("flex shrink-0 snap-start", slideClassName)}>
              {slide}
            </li>
          ))}
        </ul>
        {count > 1 && (
          <>
            <Button
              aria-label="Листать назад"
              className="absolute top-1/2 left-2 hidden -translate-y-1/2 pointer-fine:inline-flex"
              disabled={index === 0}
              onClick={() => {
                go(index - 1);
              }}
              size="icon-sm"
              variant="outline"
            >
              <ChevronLeft />
            </Button>
            <Button
              aria-label="Листать вперёд"
              className="absolute top-1/2 right-2 hidden -translate-y-1/2 pointer-fine:inline-flex"
              disabled={index === count - 1}
              onClick={() => {
                go(index + 1);
              }}
              size="icon-sm"
              variant="outline"
            >
              <ChevronRight />
            </Button>
          </>
        )}
      </div>
      {counter && count > 1 && (
        <div className="flex items-center justify-between gap-3 type-caption text-muted-foreground">
          <span aria-hidden className="flex gap-1.5">
            {Array.from({ length: count }, (_, position) => (
              <span
                className={cn(
                  "size-1.5 rounded-full transition-colors motion-reduce:transition-none",
                  position === index ? "bg-foreground" : "bg-bro-line"
                )}
                key={position}
              />
            ))}
          </span>
          <span aria-hidden>
            {index + 1} / {count}
          </span>
          <span aria-live="polite" className="sr-only">
            {index + 1} из {count}
          </span>
        </div>
      )}
    </section>
  );
}
/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */
