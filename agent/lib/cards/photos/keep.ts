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
/**
 * All the photos of a card: the person waits for the card meanwhile. Up to
 * 18 photos (three options with five more each) at 6 at a time are three
 * rounds of a download (0.3–2 s) and a copy to the store (1.5–3 s by day,
 * 8 s at worst, `docs/dev-notes.md`). Thirty seconds bounds the wait without
 * promising every photo: the rows' own photos go first, then those behind
 * «Подробнее»; a slow site or store may still lose either.
 */
const keepingTimeoutMs = 30_000;
/** Photos in flight at once, which also bounds the memory they take (8 MB each). */
const keepingConcurrency = 6;

/** Sites that look at what a client accepts get one of the three types a card shows. */
const photoRequestHeaders = {
  accept: "image/webp,image/jpeg,image/png;q=0.9,*/*;q=0.1",
};

/**
 * The photos of a block by set, in the order it shows them. The block's own
 * set — an image, a gallery, the rows' or options' photos — shows whole or
 * not at all (`whole`); each row's or option's photos behind «Подробнее»
 * (`more`, by its position) show those that were kept.
 */
const ownPhotoSet = (urls: readonly string[]) => [
  { set: "own", urls, whole: true },
];
const morePhotoSets = (
  items: readonly {
    readonly more?:
      | { readonly photos?: readonly { readonly url: string }[] }
      | undefined;
  }[]
) =>
  items.map((item, position) => ({
    set: `more-${String(position)}`,
    urls: item.more?.photos?.map((photo) => photo.url) ?? [],
    whole: false,
  }));

function blockPhotoSets(block: Block) {
  switch (block.type) {
    case "image":
      return ownPhotoSet([block.url]);
    case "gallery":
      return ownPhotoSet(block.photos.map((photo) => photo.url));
    case "list":
      return [
        ...ownPhotoSet(
          block.rows.flatMap((row) => (row.photo ? [row.photo.url] : []))
        ),
        ...morePhotoSets(block.rows),
      ];
    case "choice":
      return [
        ...ownPhotoSet(
          block.options.flatMap((option) =>
            option.photo ? [option.photo.url] : []
          )
        ),
        ...morePhotoSets(block.options),
      ];
    default:
      return [];
  }
}

type More = NonNullable<
  Extract<Block, { type: "choice" }>["options"][number]["more"]
>;

/**
 * A row's or an option's «Подробнее» with Bro's addresses for the photos that
 * were kept and without those that were not; one left with nothing to show
 * is gone.
 */
function withMorePhotos(
  more: More | undefined,
  paths: readonly (string | undefined)[] | undefined
) {
  if (!more?.photos) return more;
  const { photos, ...rest } = more;
  const kept = photos.flatMap((photo, position) => {
    const url = paths?.[position];
    return url === undefined ? [] : [{ ...photo, url }];
  });
  const shown = kept.length > 0 ? { ...rest, photos: kept } : rest;
  return Object.keys(shown).length > 0 ? shown : undefined;
}

/**
 * The block with Bro's addresses in place of its photos', in order: `paths`
 * gives each set's addresses, one per photo, undefined for a photo not kept.
 * A set that shows whole and lost a photo shows none, so the photos of a list
 * and of a choice go together, and a layout that needs them falls back to the
 * plain one; an image and a gallery are nothing but photos and go entirely.
 */
function withPhotos(
  block: Block,
  paths: (set: string) => readonly (string | undefined)[] | undefined
) {
  const own = paths("own");
  const whole =
    own?.every((url) => url !== undefined) === true ? own : undefined;
  let position = 0;
  const next = <Photo extends { readonly url: string }>(photo: Photo) => {
    const url = whole?.[position] ?? photo.url;
    position += 1;
    return { ...photo, url };
  };
  switch (block.type) {
    case "image":
      return whole ? next(block) : undefined;
    case "gallery":
      return whole ? { ...block, photos: block.photos.map(next) } : undefined;
    case "list":
      return {
        ...block,
        layout: whole || !own ? block.layout : ("rows" as const),
        rows: block.rows.map((row, at) => ({
          ...row,
          more: withMorePhotos(row.more, paths(`more-${String(at)}`)),
          photo: whole && row.photo ? next(row.photo) : undefined,
        })),
      };
    case "choice":
      return {
        ...block,
        layout: whole || !own ? block.layout : ("list" as const),
        options: block.options.map((option, at) => ({
          ...option,
          more: withMorePhotos(option.more, paths(`more-${String(at)}`)),
          photo: whole && option.photo ? next(option.photo) : undefined,
        })),
      };
    default:
      return block;
  }
}

interface PhotoJob {
  readonly block: number;
  readonly number: number;
  readonly set: string;
  readonly url: string;
  readonly whole: boolean;
}

const setOf = (job: Pick<PhotoJob, "block" | "set">) =>
  `${String(job.block)}:${job.set}`;

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
 * photos. A row's or an option's photos behind «Подробнее» show those that
 * were kept; they are copied after every set's own, which get priority while
 * the person waits. `kept` and `dropped` count the photos,
 * `droppedBlocks` names the blocks that lost any, by position.
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
  const previousNumbers = previous ? keptPhotoNumbers(cardId, previous) : [];
  const retained = new Map(
    previousNumbers.map((number) => [cardPhotoPath(cardId, number), number])
  );
  const first = Math.max(-1, ...previousNumbers) + 1;
  const sets = card.blocks.flatMap((block, position) =>
    blockPhotoSets(block).flatMap(({ set, urls, whole }) =>
      urls.map((url) => ({ block: position, set, url, whole }))
    )
  );
  const copies = new Map<string, number>();
  const jobs: PhotoJob[] = [
    ...sets.filter((job) => job.whole),
    ...sets.filter((job) => !job.whole),
  ].map(({ block, set, url, whole }) => {
    const number = copies.get(url) ?? retained.get(url) ?? first + copies.size;
    copies.set(url, number);
    return { block, set, url, whole, number };
  });
  if (jobs.length === 0) {
    return { card, droppedBlocks: [], dropped: 0, kept: 0 };
  }
  const failedSets = new Set<string>();
  const failedJobs = new Set<number>();
  const stored = new Set<number>();
  const fail = (job: PhotoJob) => {
    failedJobs.add(job.number);
    if (job.whole) failedSets.add(setOf(job));
  };
  if (!artifactStorageConfigured()) {
    console.warn("[cards] photos were not kept: no object storage");
    for (const job of jobs) if (!retained.has(job.url)) fail(job);
  }
  const deadline = AbortSignal.timeout(keepingTimeoutMs);
  const queue = new Map(jobs.map((job) => [job.number, job])).values();
  const work = async () => {
    for (const job of queue) {
      if (retained.has(job.url)) continue;
      const uses = jobs.filter((each) => each.url === job.url);
      if (
        uses.every(
          (each) => failedJobs.has(each.number) || failedSets.has(setOf(each))
        )
      )
        continue;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each worker keeps one photo at a time: the workers are the concurrency.
      const reason = await keepPhoto(cardId, job, deadline);
      if (reason === undefined || reason === "storage") stored.add(job.number);
      if (reason !== undefined) {
        for (const each of uses) fail(each);
        console.warn("[cards] a photo was not kept", { reason });
      }
    }
  };
  await Promise.all(Array.from({ length: keepingConcurrency }, work));

  const isLost = (job: PhotoJob) =>
    failedJobs.has(job.number) || failedSets.has(setOf(job));
  const lost = jobs.filter(isLost);
  const shownCopies = new Set(
    jobs.filter((job) => !isLost(job)).map((job) => job.number)
  );
  const orphans = [...stored].filter((number) => !shownCopies.has(number));
  try {
    if (orphans.length > 0) await deleteCardPhotos(cardId, orphans);
  } catch (error) {
    console.warn("[cards] copies of photos the card does not show stayed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
  const blocks = card.blocks.flatMap((block, position) => {
    const own = jobs.filter((job) => job.block === position);
    if (own.length === 0) return [block];
    const shown = withPhotos(block, (set) => {
      const ofSet = own.filter((job) => job.set === set);
      return ofSet.length === 0
        ? undefined
        : ofSet.map((job) =>
            isLost(job) ? undefined : cardPhotoPath(cardId, job.number)
          );
    });
    return shown ? [shown] : [];
  });
  return {
    card: cardSchema.safeParse({ ...card, blocks }).data,
    droppedBlocks: [...new Set(lost.map((job) => job.block))].toSorted(
      (a, b) => a - b
    ),
    dropped: lost.length,
    kept: jobs.length - lost.length,
  };
}

/**
 * What a card tool's result says of the card's photos: nothing for a card
 * without any; otherwise how many were kept and dropped, and, when some were
 * dropped, a line for the model naming the blocks that went without them.
 */
export function photosResult({
  dropped,
  droppedBlocks,
  kept,
}: Awaited<ReturnType<typeof keepCardPhotos>>) {
  if (kept + dropped === 0) return { note: "" };
  const blocks = droppedBlocks
    .map((block) => `blocks[${String(block)}]`)
    .join(", ");
  return {
    note:
      dropped === 0
        ? ""
        : ` ${String(dropped)} of its ${String(dropped + kept)} photos could not be kept (not downloadable, not a photo, or too small), so ${blocks} went without photos; an image or a gallery left without them is not on the card. Never tell the person those photos are there.`,
    photos: { dropped, kept },
  };
}
