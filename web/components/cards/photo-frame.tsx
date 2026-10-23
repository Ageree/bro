"use client";

import { useState } from "react";
import type { Card } from "@shared/cards/schema";
import { cn } from "@web/components/class-names";

type Photo = Pick<
  Extract<Card["blocks"][number], { type: "image" }>,
  "alt" | "url"
>;

/** A frame's proportions: a gallery's `ratio`, and 4:3 everywhere else. */
const ratios = {
  portrait: "aspect-3/4",
  square: "aspect-square",
  wide: "aspect-4/3",
} as const satisfies Record<
  Extract<Card["blocks"][number], { type: "gallery" }>["ratio"],
  string
>;

/**
 * A photo of a card in a frame of fixed proportions, so the page keeps the
 * photo's place while it loads (a soft fill, nothing jumps) and a slow network
 * only shows the fill for longer. A photo that does not load takes its frame
 * with it, instead of leaving an empty box, and tells `onFailure`; one that
 * failed before the page came to life is caught when it does. `className`
 * sizes and rounds the frame (a thumbnail is `size-18 rounded-sm`); the photo
 * fills it, cropped to the middle.
 */
export function PhotoFrame({
  className,
  eager = false,
  onFailure,
  photo,
  ratio = "wide",
}: {
  readonly className?: string;
  readonly eager?: boolean;
  readonly onFailure?: () => void;
  readonly photo: Photo;
  readonly ratio?: keyof typeof ratios;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const fail = () => {
    setFailed(true);
    onFailure?.();
  };
  return (
    <span
      className={cn(
        "relative block overflow-hidden bg-secondary",
        ratios[ratio],
        className
      )}
    >
      {/* oxlint-disable-next-line nextjs/no-img-element -- the photo is Bro's own copy behind the card's link, which next/image would fetch and cache on the server by that secret address */}
      <img
        alt={photo.alt}
        className="absolute inset-0 size-full object-cover"
        decoding="async"
        draggable={false}
        loading={eager ? "eager" : "lazy"}
        onError={fail}
        ref={(image) => {
          if (image?.complete && image.naturalWidth === 0) fail();
        }}
        referrerPolicy="no-referrer"
        src={photo.url}
      />
    </span>
  );
}
