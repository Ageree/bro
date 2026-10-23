"use client";

import { useState } from "react";
import type { Card } from "@shared/cards/schema";
import { Carousel } from "./carousel";
import { Lightbox } from "./lightbox";
import { PhotoFrame } from "./photo-frame";

type Gallery = Extract<Card["blocks"][number], { type: "gallery" }>;

/**
 * Several photos of one thing (`docs/cards.md`, «Фото в карточках»): a strip
 * to swipe, the next photo peeking in, «2 / 5» and the dots under it, and the
 * caption with the site the photos came from. A tap opens the photo on the
 * full screen. A photo that does not load leaves the strip, and its count
 * with it; a gallery left with none is not shown.
 */
export function GalleryBlock({ block }: { readonly block: Gallery }) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [current, setCurrent] = useState(0);
  const [opened, setOpened] = useState<number>();
  const photos = block.photos.filter((photo) => !failed.has(photo.url));
  if (photos.length === 0) return null;
  const credit = (photos[current] ?? photos[0])?.credit;
  return (
    <figure className="flex flex-col gap-3">
      <Carousel
        counter
        label={block.caption ?? "Фото"}
        onIndexChange={setCurrent}
        slideClassName="w-[calc(100%-1.5rem)]"
      >
        {photos.map((photo, position) => (
          <button
            aria-haspopup="dialog"
            className="w-full cursor-zoom-in overflow-hidden rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            key={photo.url}
            onClick={() => {
              setOpened(position);
            }}
            type="button"
          >
            <PhotoFrame
              eager={position === 0}
              onFailure={() => {
                setFailed((before) => new Set(before).add(photo.url));
              }}
              photo={photo}
              ratio={block.ratio}
            />
          </button>
        ))}
      </Carousel>
      {(block.caption ?? credit) && (
        <figcaption className="type-caption wrap-anywhere text-muted-foreground">
          {block.caption}
          {block.caption && credit && " · "}
          {credit && `Фото: ${credit}`}
        </figcaption>
      )}
      <Lightbox
        index={opened}
        onClose={() => {
          setOpened(undefined);
        }}
        photos={photos}
      />
    </figure>
  );
}
