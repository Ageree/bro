import type { LanguageModelMiddleware } from "ai";
import { z } from "zod";
import { namedAttachmentPaths } from "@agent/lib/sandbox/inbox";

/**
 * RouterAI's parse of the PDFs the person sent. The provider parses a PDF
 * file part anew on every call, 5–10 s for a scan, unless the assistant
 * message after it carries the parse it answered with (`annotations`, whose
 * `file.name` is the part's filename, the staged path). eve does not keep
 * them in the history, so they are kept here, in the process's memory, by
 * path: the path's hash names the bytes, so one entry serves every session
 * with the same file, and a restart costs one parse.
 */

export const annotationSchema = z
  .object({
    file: z.object({ hash: z.string(), name: z.string() }).catchall(z.json()),
    type: z.literal("file"),
  })
  .catchall(z.json());

type Annotation = z.infer<typeof annotationSchema>;

const metadataSchema = z.object({
  openrouter: z.object({ annotations: z.array(annotationSchema) }),
});

/** A step's provider metadata, as middleware sees it. */
type ProviderMetadata = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>
>["providerMetadata"];

/** A parse past this (a scan's page images) is parsed again instead. */
const maximumEntryChars = 4 * 1024 * 1024;
const maximumEntries = 200;
const maximumTotalChars = 32 * 1024 * 1024;

/** The parses by path, the least recently used first. */
const parses = new Map<
  string,
  { readonly annotation: Annotation; readonly chars: number }
>();
let totalChars = 0;

function forget(path: string) {
  const entry = parses.get(path);
  if (entry === undefined) return;
  parses.delete(path);
  totalChars -= entry.chars;
}

/** Keeps the parses a model call answered with, for the staged PDFs only. */
export function rememberAnnotations(metadata: ProviderMetadata) {
  const annotations =
    metadataSchema.safeParse(metadata).data?.openrouter.annotations ?? [];
  for (const annotation of annotations) {
    const path = annotation.file.name;
    if (namedAttachmentPaths(path)[0] !== path) continue;
    const chars = JSON.stringify(annotation).length;
    forget(path);
    if (chars > maximumEntryChars) continue;
    parses.set(path, { annotation, chars });
    totalChars += chars;
    for (const [oldest] of parses) {
      if (parses.size <= maximumEntries && totalChars <= maximumTotalChars) {
        break;
      }
      forget(oldest);
    }
  }
}

/** The kept parses of these paths. */
export function annotationsFor(paths: readonly string[]) {
  return paths.flatMap((path) => {
    const entry = parses.get(path);
    if (entry === undefined) return [];
    // Used again: the last to go.
    parses.delete(path);
    parses.set(path, entry);
    return [entry.annotation];
  });
}
