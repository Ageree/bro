import type { readBrowserRun } from "@db/services/browser-runs";
import {
  captureImageArtifact,
  imageArtifactStorageConfigured,
  type ImageArtifactCapture,
} from "@agent/lib/image-artifact/capture";
import { maximumDeliveredImageArtifacts } from "@agent/lib/image-artifact/delivery";
import { downloadWithin } from "@agent/lib/inbound-media/download";
import { maximumBrowserImageBytes } from "@shared/browser/artifact";
import { captureViewportOverCdp } from "./cdp";
import {
  findBrowserUseSessionCdpUrl,
  listBrowserUseWorkspaceFiles,
  type readBrowserUseRun,
} from "./client";

/**
 * The pictures a run leaves behind, turned into artifacts the coordinator can
 * attach to a message. A marketplace behind an anti-bot wall will not hand its
 * pictures to a plain fetch, but the run's own browser is already past that
 * wall, so the pictures come from the run:
 *
 * - the run saves them into one folder of its workspace — the page that shows
 *   the outcome always, pictures of the items only when the errand asked;
 * - when the run saved no page of its own, the browser it finished in is
 *   still up, and its viewport is photographed over the debugger instead.
 *
 * Every image that makes it becomes a ready `browser_image_artifacts` row for
 * the conversation, at most as many as one message may carry.
 */

/** The workspace folder a run is asked to save its pictures into. */
export const browserRunImagePrefix = "report/";
/** The file every run is asked to save: the page that shows the outcome. */
export const browserRunFinalScreenshotStem = "final";

const finalScreenshotLabel = "скриншот страницы с результатом";

/** Which saved files are worth a download. The bytes still decide the type. */
const imageExtensions = new Set(["gif", "jpeg", "jpg", "png", "webp"]);
const maximumLabelLength = 80;
const fallbackItemLabel = "фото товара";

// Every run in a session shares the workspace, so a file older than the run
// belongs to an earlier errand. A minute of slack covers the clock drift
// between the run's record and the object store's timestamps.
const earlierRunSlackMs = 60_000;

type BrowserRunRow = Pick<
  NonNullable<Awaited<ReturnType<typeof readBrowserRun>>>,
  "createdByUserId" | "id" | "rootSessionId" | "sessionId" | "workspaceId"
>;

type BrowserUseRunSummary = Pick<
  Awaited<ReturnType<typeof readBrowserUseRun>>,
  "createdAt" | "workspaceId"
>;

type WorkspaceFile = Awaited<
  ReturnType<typeof listBrowserUseWorkspaceFiles>
>["files"][number];

type RunImageFile = NonNullable<ReturnType<typeof describeImageFile>>;

export interface BrowserRunImage {
  readonly id: string;
  readonly label: string;
}

/**
 * The workspace files worth keeping, the final screenshot first and the rest
 * in name order, cut to what one message may carry. Anything that is not an
 * image by extension, has no download URL, is empty or past the cap, or was
 * written before this run started stays where it is.
 */
function selectBrowserRunImages(
  files: readonly WorkspaceFile[],
  runCreatedAt: string | undefined
) {
  const since =
    runCreatedAt === undefined
      ? Number.NaN
      : Date.parse(runCreatedAt) - earlierRunSlackMs;
  return files
    .flatMap((file) => {
      const image = describeImageFile(file);
      return image ? [image] : [];
    })
    .filter(
      (file) =>
        file.size > 0 &&
        file.size <= maximumBrowserImageBytes &&
        (Number.isNaN(since) || Date.parse(file.lastModified) >= since)
    )
    .toSorted((left, right) => {
      if (left.final !== right.final) return left.final ? -1 : 1;
      return left.path.localeCompare(right.path);
    })
    .slice(0, maximumDeliveredImageArtifacts);
}

function describeImageFile(file: WorkspaceFile) {
  if (!file.url || !file.path.startsWith(browserRunImagePrefix)) {
    return undefined;
  }
  const filename = file.path.slice(browserRunImagePrefix.length);
  // Only the folder itself: a nested path is not what the run was asked for.
  if (filename.length === 0 || filename.includes("/")) return undefined;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const stem = filename.slice(0, dot);
  if (!imageExtensions.has(filename.slice(dot + 1).toLowerCase())) {
    return undefined;
  }
  return {
    final: stem === browserRunFinalScreenshotStem,
    lastModified: file.lastModified,
    path: file.path,
    size: file.size,
    stem,
    url: file.url,
  };
}

/**
 * «xiaomi-band-9» reads as «xiaomi band 9» in the list the coordinator gets.
 * The name was chosen by an agent that spent the run reading shop pages, so
 * only letters, digits and spaces survive, and not many of them: it is a
 * caption, not a channel for instructions.
 */
function labelFromStem(stem: string) {
  const label = stem
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, maximumLabelLength)
    .trim();
  return label.length > 0 ? label : fallbackItemLabel;
}

export async function captureBrowserRunImages(
  row: BrowserRunRow,
  run: BrowserUseRunSummary
): Promise<BrowserRunImage[]> {
  const rootSessionId = row.rootSessionId;
  if (!rootSessionId || !imageArtifactStorageConfigured()) return [];
  const saved = selectBrowserRunImages(
    await listRunImageFiles(row, run),
    run.createdAt
  );
  const savedFinal = saved.some((file) => file.final);
  // Room for the photographed viewport when the run left no page of its own.
  const files = savedFinal
    ? saved
    : saved.slice(0, maximumDeliveredImageArtifacts - 1);
  const context = { rootSessionId, row };
  const [viewport, captured] = await Promise.all([
    savedFinal ? undefined : settled(row, "viewport", captureViewport(context)),
    Promise.all(
      files.map((file) =>
        settled(row, file.path, captureSavedImage(context, file))
      )
    ),
  ]);
  return [viewport, ...captured].filter((image) => image !== undefined);
}

interface RunImageContext {
  readonly rootSessionId: string;
  readonly row: BrowserRunRow;
}

async function listRunImageFiles(
  row: BrowserRunRow,
  run: BrowserUseRunSummary
): Promise<readonly WorkspaceFile[]> {
  if (!run.workspaceId) return [];
  try {
    const listed = await listBrowserUseWorkspaceFiles(
      run.workspaceId,
      browserRunImagePrefix
    );
    return listed.files;
  } catch (error) {
    console.warn("[browser-use] run images could not be listed", {
      cause: error,
      runId: row.id,
    });
    return [];
  }
}

/** One image lost is one image lost: the others and the report still go. */
async function settled(
  row: BrowserRunRow,
  source: string,
  capture: Promise<BrowserRunImage | undefined>
) {
  try {
    return await capture;
  } catch (error) {
    console.warn("[browser-use] run image could not be captured", {
      cause: error,
      runId: row.id,
      source,
    });
    return undefined;
  }
}

async function captureSavedImage(context: RunImageContext, file: RunImageFile) {
  // The presigned URL is never logged: it is a credential for the file.
  const download = await downloadWithin(
    new URL(file.url),
    maximumBrowserImageBytes
  );
  if (download.kind !== "bytes") {
    console.warn("[browser-use] run image could not be downloaded", {
      path: file.path,
      reason: download.kind === "failed" ? download.reason : "oversize",
      runId: context.row.id,
    });
    return undefined;
  }
  return keep(context, {
    bytes: download.bytes,
    idempotencyKey: `browser-run:${context.row.id}:${file.path}`,
    label: file.final ? finalScreenshotLabel : labelFromStem(file.stem),
    name: file.final ? browserRunFinalScreenshotStem : file.stem,
    sourceKind: file.final ? "viewport" : "image_resource",
  });
}

async function captureViewport(context: RunImageContext) {
  const cdpUrl = await findBrowserUseSessionCdpUrl(context.row.sessionId);
  if (cdpUrl === undefined) return undefined;
  return keep(context, {
    bytes: await captureViewportOverCdp(cdpUrl),
    idempotencyKey: `browser-run:${context.row.id}:viewport`,
    label: finalScreenshotLabel,
    name: browserRunFinalScreenshotStem,
    sourceKind: "viewport",
  });
}

function keep(
  context: RunImageContext,
  image: Pick<
    ImageArtifactCapture,
    "bytes" | "idempotencyKey" | "label" | "name" | "sourceKind"
  >
) {
  const { row } = context;
  return captureImageArtifact(
    { userId: row.createdByUserId, workspaceId: row.workspaceId },
    {
      ...image,
      browserSessionId: row.sessionId,
      rootSessionId: context.rootSessionId,
      workerSessionId: row.id,
    }
  );
}
