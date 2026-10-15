"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../landing.module.css";

const desktopRecipe = {
  meaningfulHeight: 196,
  stepX: 126,
  stepY: 156,
  firstRowY: -48,
};
const mobileRecipe = {
  meaningfulHeight: 148,
  stepX: 96,
  stepY: 120,
  firstRowY: -36,
};

const portraits = [
  { file: "s01-bro-portrait.webp", x: 203, y: 61, width: 876, height: 1151 },
  { file: "s02-bro-portrait.webp", x: 124, y: 74, width: 1013, height: 1133 },
  { file: "s03-bro-portrait.webp", x: 84, y: 65, width: 1092, height: 1149 },
  { file: "s04-bro-portrait.webp", x: 166, y: 68, width: 923, height: 1141 },
  { file: "s05-bro-portrait.webp", x: 58, y: 37, width: 1136, height: 1180 },
  { file: "s06-bro-portrait.webp", x: 116, y: 67, width: 1025, height: 1142 },
  { file: "s07-bro-portrait.webp", x: 74, y: 66, width: 1107, height: 1150 },
  { file: "s08-bro-portrait.webp", x: 107, y: 69, width: 1040, height: 1141 },
  { file: "s09-bro-portrait.webp", x: 176, y: 64, width: 932, height: 1148 },
  { file: "s10-bro-portrait.webp", x: 120, y: 88, width: 1071, height: 1114 },
  { file: "s11-bro-portrait.webp", x: 158, y: 70, width: 938, height: 1140 },
  { file: "s12-bro-portrait.webp", x: 19, y: 83, width: 1220, height: 1094 },
];

function PortraitInstance({
  row,
  column,
  recipe,
  bounds,
}: {
  readonly row: number;
  readonly column: number;
  readonly recipe: typeof desktopRecipe;
  readonly bounds?: Pick<DOMRectReadOnly, "width" | "height">;
}) {
  const portraitIndex =
    (((row * 5 + column * 7) % portraits.length) + portraits.length) %
    portraits.length;
  const portrait = portraits[portraitIndex];
  if (!portrait) return null;
  const scale = recipe.meaningfulHeight / portrait.height;
  const center = column * recipe.stepX + (Math.abs(row % 2) * recipe.stepX) / 2;
  const left = center - (portrait.width * scale) / 2;
  const top = recipe.firstRowY + row * recipe.stepY;
  if (
    bounds &&
    (left > bounds.width ||
      left + portrait.width * scale < 0 ||
      top > bounds.height ||
      top + recipe.meaningfulHeight < 0)
  )
    return null;
  const x = center - (portrait.x + portrait.width / 2) * scale;
  const y = top - portrait.y * scale;
  return (
    <g
      transform={`translate(${String(x)} ${String(y)}) scale(${String(scale)})`}
    >
      <use
        className={styles.portraitImage}
        data-portrait={portrait.file}
        data-portrait-instance={`${String(row)}:${String(column)}`}
        href={`#bro-portrait-${String(portraitIndex)}`}
        style={{
          transformOrigin: `${String(((portrait.x + portrait.width / 2) / 1254) * 100)}% ${String(((portrait.y + portrait.height / 2) / 1254) * 100)}%`,
        }}
      />
    </g>
  );
}

function PortraitPattern({
  id,
  recipe,
}: {
  readonly id: string;
  readonly recipe: typeof desktopRecipe;
}) {
  return (
    <pattern
      height={recipe.stepY * portraits.length}
      id={id}
      patternUnits="userSpaceOnUse"
      width={recipe.stepX * portraits.length}
    >
      {Array.from({ length: 14 * 14 }, (_, index) => (
        <PortraitInstance
          row={Math.floor(index / 14) - 1}
          column={(index % 14) - 1}
          recipe={recipe}
          key={index}
        />
      ))}
    </pattern>
  );
}

export function PortraitWallpaper() {
  const frame = useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = useState<Pick<
    DOMRectReadOnly,
    "width" | "height"
  > | null>(null);
  useEffect(() => {
    if (!frame.current) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setViewport({ width, height });
    });
    observer.observe(frame.current);
    return () => {
      observer.disconnect();
    };
  }, []);

  const recipe =
    viewport && viewport.width <= 600 ? mobileRecipe : desktopRecipe;
  const columns = viewport ? Math.ceil(viewport.width / recipe.stepX) + 1 : 0;
  const rows = viewport
    ? Math.ceil((viewport.height - recipe.firstRowY) / recipe.stepY)
    : 0;

  return (
    <svg
      aria-hidden="true"
      className={styles.wallpaper}
      data-portrait-wallpaper=""
      data-wallpaper-ready={viewport ? "true" : "false"}
      focusable="false"
      ref={frame}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        {portraits.map((portrait, index) => (
          <image
            height="1254"
            href={`/brand/portraits/${portrait.file}`}
            id={`bro-portrait-${String(index)}`}
            key={portrait.file}
            width="1254"
          />
        ))}
        {!viewport && (
          <PortraitPattern id="bro-crowd-desktop" recipe={desktopRecipe} />
        )}
        {!viewport && (
          <PortraitPattern id="bro-crowd-mobile" recipe={mobileRecipe} />
        )}
      </defs>
      {viewport ? (
        Array.from({ length: rows * columns }, (_, index) => (
          <PortraitInstance
            row={Math.floor(index / columns)}
            column={index % columns}
            recipe={recipe}
            bounds={viewport}
            key={`${String(Math.floor(index / columns))}:${String(index % columns)}`}
          />
        ))
      ) : (
        <rect className={styles.wallpaperFill} height="100%" width="100%" />
      )}
    </svg>
  );
}
