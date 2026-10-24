"use client";

import { XIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Card } from "@shared/cards/schema";
import { cn } from "@web/components/class-names";
import { Button } from "@web/components/ui/button";
import { Carousel } from "./carousel";
import { holdScreen } from "./telegram";

type Photo = Extract<
  Card["blocks"][number],
  { type: "gallery" }
>["photos"][number];

/** How far down a photo is pulled before letting go closes the viewer. */
const closingPullPx = 96;

/**
 * The photos of a gallery on the full screen, from the one tapped: a strip to
 * swipe or step through with the arrow keys, closed by its button, by Escape
 * or by pulling the photo down. It is the page's own modal `<dialog>`: the
 * page under it is inert, focus starts on the strip and goes back to the photo
 * that opened it, and the card page loads no dialog library for it. Inside
 * Telegram the Mini App's own pull-to-close is held off meanwhile, so the pull
 * closes the viewer and not the card.
 */
export function Lightbox({
  index,
  onClose,
  photos,
}: {
  readonly index: number | undefined;
  readonly onClose: () => void;
  readonly photos: readonly Photo[];
}) {
  const open = index !== undefined;
  const [opened, setOpened] = useState(index);
  const [current, setCurrent] = useState(index ?? 0);
  const [pull, setPull] = useState(0);
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  if (opened !== index) {
    setOpened(index);
    setCurrent(index ?? 0);
  }
  const photo = photos[current];

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!open || !node) return undefined;
    const opener = document.activeElement;
    const release = holdScreen();
    node.showModal();
    node.querySelector<HTMLElement>("ul")?.focus();
    return () => {
      node.close();
      release();
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open]);

  const release = () => {
    const pulled = pull;
    start.current = undefined;
    setPull(0);
    if (pulled > closingPullPx) onClose();
  };

  return (
    <dialog
      aria-label={`Фото ${String(current + 1)} из ${String(photos.length)}`}
      className="m-0 size-full max-h-none max-w-none touch-none overflow-hidden bg-foreground p-0 text-background backdrop:bg-foreground"
      onClose={(event) => {
        event.stopPropagation();
        if (open) onClose();
      }}
      onPointerCancel={release}
      onPointerDown={(event) => {
        if (event.isPrimary) {
          start.current = { x: event.clientX, y: event.clientY };
        }
      }}
      onPointerMove={(event) => {
        const from = start.current;
        if (!from) return;
        const down = event.clientY - from.y;
        if (down > 0 && down > Math.abs(event.clientX - from.x)) setPull(down);
      }}
      onPointerUp={release}
      ref={dialog}
    >
      {open && (
        <div className="flex h-dvh flex-col gap-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center justify-between gap-3 px-4">
            <p aria-hidden className="type-caption">
              {current + 1} / {photos.length}
            </p>
            <Button
              aria-label="Закрыть"
              onClick={onClose}
              size="icon-sm"
              variant="outline"
            >
              <XIcon />
            </Button>
          </div>
          <div
            className={cn(
              "min-h-0 flex-1",
              pull === 0 && "motion-safe:transition-[transform,opacity]"
            )}
            style={{
              opacity: 1 - Math.min(pull / (closingPullPx * 3), 0.5),
              transform: pull > 0 ? `translateY(${String(pull)}px)` : undefined,
            }}
          >
            <Carousel
              initialIndex={opened ?? 0}
              label="Фото на весь экран"
              onIndexChange={setCurrent}
              slideClassName="h-full w-full touch-pan-x touch-pinch-zoom items-center justify-center"
              variant="screen"
            >
              {photos.map((item) => (
                // oxlint-disable-next-line nextjs/no-img-element -- Bro's own copy behind the card's link, as in PhotoFrame
                <img
                  alt={item.alt}
                  className="max-h-full max-w-full object-contain"
                  decoding="async"
                  draggable={false}
                  key={item.url}
                  referrerPolicy="no-referrer"
                  src={item.url}
                />
              ))}
            </Carousel>
          </div>
          {photo && (
            <p className="px-4 type-caption wrap-anywhere text-background/75">
              {photo.alt}
              {photo.credit && ` · Фото: ${photo.credit}`}
            </p>
          )}
        </div>
      )}
    </dialog>
  );
}
