import { downloadWithin } from "@agent/lib/inbound-media/download";
import { isBlockedHost } from "@agent/lib/outbound-media/attachments";
import { fetchPublic } from "@agent/lib/sandbox/public-fetch";
import {
  cardPhotoObject,
  cardPhotoPath,
  deleteCardPhotos,
  keptPhotoNumbers,
} from "@shared/cards/photos";
import { type Card, cardSchema } from "@shared/cards/schema";
import {
  artifactStorageConfigured,
  putArtifactObject,
} from "@shared/object-storage/artifacts";
import { cleanPhoto } from "./clean";

/**
 * Bro's own copy of every photo a card shows (`docs/cards.md`, «Фото в
 * карточках»): the page never loads a picture from the site Bro found it on.
 * Each photo is downloaded the way an attachment is (`fetchPublic`, every
 * redirect checked, public hosts only), checked and stripped of its metadata
 * (`./clean`), and kept in Object Storage under the card's link. Nothing here
 * logs an address: a listing's link can carry a personal token.
 */

type Block = Card["blocks"][number];

const maximumPhotoBytes = 8 * 1024 * 1024;
/** One hop of one photo, its body included. */
const photoHopTimeoutMs = 8000;
/** All the photos of a card: the person waits for the card meanwhile. */
const keepingTimeoutMs = 20_000;
/** Photos in flight at once, which also bounds the memory they take. */
const keepingConcurrency = 4;

/** Sites that look at what a client accepts get one of the three types a card shows. */
const photoRequestHeaders = {
  accept: "image/webp,image/jpeg,image/png;q=0.9,*/*;q=0.1",
};

/**
 * The photo addresses of a block, in the order it shows them: one for an
 * image, each of a gallery, and each row's or option's when the set has them.
 */
function blockPhotos(block: Block) {
  switch (block.type) {
    case "image":
      return [block.url];
    case "gallery":
      return block.photos.map((photo) => photo.url);
    case "list":
      return block.rows.flatMap((row) => (row.photo ? [row.photo.url] : []));
    case "choice":
      return block.options.flatMap((option) =>
        option.photo ? [option.photo.url] : []
      );
    default:
      return [];
  }
}

/**
 * The block with Bro's addresses in place of its photos', in order; without
 * `paths`, the block as it reads without photos. A set never shows half its
 * photos, so the photos of a list and of a choice go together, and a layout
 * that needs them falls back to the plain one; an image and a gallery are
 * nothing but photos and go entirely.
 */
function withPhotos(block: Block, paths: readonly string[] | undefined) {
  let position = 0;
  const next = <Photo extends { readonly url: string }>(photo: Photo) => {
    const url = paths?.[position] ?? photo.url;
    position += 1;
    return { ...photo, url };
  };
  switch (block.type) {
    case "image":
      return paths ? next(block) : undefined;
    case "gallery":
      return paths ? { ...block, photos: block.photos.map(next) } : undefined;
    case "list":
      return {
        ...block,
        layout: paths ? block.layout : ("rows" as const),
        rows: block.rows.map((row) => ({
          ...row,
          photo: paths && row.photo ? next(row.photo) : undefined,
        })),
      };
    case "choice":
      return {
        ...block,
        layout: paths ? block.layout : ("list" as const),
        options: block.options.map((option) => ({
          ...option,
          photo: paths && option.photo ? next(option.photo) : undefined,
        })),
      };
    default:
      return block;
  }
}

interface PhotoJob {
  readonly block: number;
  readonly number: number;
  readonly url: string;
}

/** Why a photo was not kept, in words safe to log: never its address. */
async function keepPhoto(cardId: string, job: PhotoJob, signal: AbortSignal) {
  const url = URL.parse(job.url);
  if (url?.protocol !== "https:" || isBlockedHost(url.hostname)) {
    return "not-a-public-https-url";
  }
  const download = await downloadWithin(url, maximumPhotoBytes, {
    allowUrl: (hop) => !isBlockedHost(hop.hostname),
    fetch: fetchPublic,
    headers: photoRequestHeaders,
    signal,
    timeoutMs: photoHopTimeoutMs,
  });
  if (download.kind === "oversize") return "oversize";
  if (download.kind === "failed") return download.reason;
  const photo = cleanPhoto(download.bytes);
  if (photo.kind === "refused") return photo.reason;
  try {
    await putArtifactObject({
      bytes: photo.bytes,
      mediaType: photo.mediaType,
      pathname: cardPhotoObject(cardId, job.number),
      signal,
    });
  } catch {
    return "storage";
  }
  return undefined;
}

/**
 * Copies the photos of a card into Bro's storage under its link, and returns
 * the card with Bro's addresses in their place. A set (a list's rows, a
 * choice's options, a gallery, an image) whose photo was not kept for any
 * reason shows none, so the card that comes back may have fewer photos, or
 * fewer blocks, than the one given, and none at all when it had nothing but
 * photos. `kept` and `dropped` count the photos, `droppedBlocks` names the
 * blocks that lost theirs, by position.
 *
 * `previous` is the card as it was kept before, for a card that is updated:
 * the new copies take numbers past its own, so a page that still holds an old
 * photo never shows it in a new place. Its copies are the caller's to remove
 * once the new card is kept (`deleteCardPhotos`).
 */
export async function keepCardPhotos(
  cardId: string,
  card: Card,
  previous?: Card
) {
  const first =
    Math.max(-1, ...(previous ? keptPhotoNumbers(cardId, previous) : [])) + 1;
  const jobs = card.blocks
    .flatMap((block, position) =>
      blockPhotos(block).map((url) => ({ block: position, url }))
    )
    .map(({ block, url }, index) => ({ block, number: first + index, url }));
  if (jobs.length === 0) {
    return { card, droppedBlocks: [], dropped: 0, kept: 0 };
  }
  const failed = new Set<number>();
  const stored = new Set<number>();
  if (!artifactStorageConfigured()) {
    console.warn("[cards] photos were not kept: no object storage");
    for (const job of jobs) failed.add(job.block);
  }
  const deadline = AbortSignal.timeout(keepingTimeoutMs);
  const queue = jobs.values();
  const work = async () => {
    for (const job of queue) {
      if (failed.has(job.block)) continue;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each worker keeps one photo at a time: the workers are the concurrency.
      const reason = await keepPhoto(cardId, job, deadline);
      if (reason === undefined || reason === "storage") stored.add(job.number);
      if (reason !== undefined) {
        failed.add(job.block);
        console.warn("[cards] a photo was not kept", { reason });
      }
    }
  };
  await Promise.all(Array.from({ length: keepingConcurrency }, work));

  const lost = jobs.filter((job) => failed.has(job.block));
  const orphans = lost.flatMap((job) =>
    stored.has(job.number) ? [job.number] : []
  );
  try {
    if (orphans.length > 0) await deleteCardPhotos(cardId, orphans);
  } catch (error) {
    console.warn("[cards] copies of photos the card does not show stayed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
  const blocks = card.blocks.flatMap((block, position) => {
    const paths = jobs.flatMap((job) =>
      job.block === position ? [cardPhotoPath(cardId, job.number)] : []
    );
    if (paths.length === 0) return [block];
    const shown = withPhotos(block, failed.has(position) ? undefined : paths);
    return shown ? [shown] : [];
  });
  return {
    card: cardSchema.safeParse({ ...card, blocks }).data,
    droppedBlocks: [...failed].toSorted((a, b) => a - b),
    dropped: lost.length,
    kept: jobs.length - lost.length,
  };
}
