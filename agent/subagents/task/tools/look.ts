import { posix } from "node:path";
import {
  defineDynamic,
  defineTool,
  toolOutput,
  toolOutputPart,
} from "eve/tools";
import { z } from "zod";
import { rememberLookImage } from "@agent/lib/model/tool-images";
import { resolveSandboxPath } from "@agent/lib/sandbox/backend";
import { readSandboxFileWithin } from "@agent/lib/sandbox/inbox";
import { runKit } from "@agent/lib/sandbox/kit";
import { taskFilesOfCaller } from "@agent/lib/sandbox/pilot";

/** `brokit look` keeps each picture within 400 KB; more is not its picture. */
const pictureBytes = 600_000;

/** What `brokit look` prints (sandbox/kit/brokit/look.py). */
const lookResultSchema = z.object({
  items: z.array(
    z.object({
      images: z.array(
        z.object({
          file: z.string(),
          grid_step: z.number().nullable(),
          page: z.number().int(),
          region: z.array(z.number()).nullable(),
          text_chars: z.number().int().nullable(),
          view: z.object({ height: z.number(), width: z.number() }),
        })
      ),
      kind: z.enum(["image", "office", "pdf"]),
      pages_total: z.number().int().nullable(),
      path: z.string(),
      unit: z.enum(["pt", "px"]),
    })
  ),
  next: z.object({ pages: z.string(), path: z.string() }).nullable(),
  truncated: z.boolean(),
  warnings: z.array(z.string()),
});

const refusalSchema = z.object({
  error: z.string(),
  hint: z.string().optional(),
});

/** A path `look` may read: under /workspace or /tmp, `..` resolved first. */
function lookPath(path: string) {
  const resolved = posix.normalize(resolveSandboxPath(path));
  if (!resolved.startsWith("/workspace/") && !resolved.startsWith("/tmp/")) {
    throw new Error("look reads files under /workspace or /tmp only.");
  }
  return resolved;
}

/**
 * The task agent's eyes, where the person's files reach it
 * (TASK_FILES_WORKSPACES): PDF pages, photos and scans, office files drawn
 * as pages, through the kit's `brokit look` (`agent/lib/sandbox/kit.ts`).
 * The pictures never enter eve's state: each is kept in the process
 * (`rememberLookImage`) and the result carries its marker, which
 * `toolImagesMiddleware` turns into the picture in the prompt while the
 * call is among the latest two `look` calls. What a picture shows is
 * untrusted input, as a fetched page is: `look` reaches no network, and a
 * task agent that holds the person's files is off the web before its first
 * model call (`hooks/person-files.ts`), `share_file` its only way out.
 */
export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      taskFilesOfCaller(context)
        ? defineTool({
            description:
              "See files as pictures: PDF pages, images (scans, photos) or office files rendered to pages. Up to 4 pictures per call across `paths`. `pages` picks pages, `region` zooms into a box, `grid` draws coordinates (PDF points from the top-left of the page as displayed; pixels for images). Use it to read scans and photos and to check every page of a file you made before share_file. Only your last two looks stay visible: look again if you need an older picture.",
            inputSchema: z.object({
              paths: z
                .array(z.string().min(1).max(512))
                .min(1)
                .max(4)
                .describe(
                  "Files in the sandbox: PDF, image (jpg/png/webp/tiff/gif/bmp) or office (docx/xlsx/pptx/odt/ods/odp/doc/xls/ppt/rtf)."
                ),
              pages: z
                .string()
                .regex(/^\d+(-\d+)?(,\d+(-\d+)?)*$/)
                .optional()
                .describe(
                  'Pages or frames for every multi-page file: "1", "2-4", "1,3". Default: from the first page until 4 pictures.'
                ),
              grid: z
                .boolean()
                .optional()
                .describe("Draw a labelled coordinate grid."),
              region: z
                .string()
                .regex(/^\d+(\.\d+)?(,\d+(\.\d+)?){3}$/)
                .optional()
                .describe(
                  "x0,y0,x1,y1 in grid units; only with one file and one page: small print, a field, a stamp."
                ),
              note: z
                .string()
                .max(200)
                .optional()
                .describe("What you are checking; echoed back."),
            }),
            async execute(input, ctx) {
              const sandbox = await ctx.getSandbox();
              const paths = input.paths.map(lookPath);
              const out = `/workspace/.bro/look/${ctx.callId.replaceAll(/[^\w-]/gu, "_")}`;
              try {
                const run = await runKit(
                  sandbox,
                  [
                    "look",
                    ...paths,
                    "--out",
                    out,
                    ...(input.pages === undefined
                      ? []
                      : ["--pages", input.pages]),
                    ...(input.grid === true ? ["--grid"] : []),
                    ...(input.region === undefined
                      ? []
                      : ["--region", input.region]),
                  ],
                  { signal: ctx.abortSignal, timeoutMs: 120_000 }
                );
                if (run.exitCode !== 0) {
                  const refusal = refusalSchema.safeParse(run.json).data;
                  throw new Error(
                    refusal === undefined
                      ? `look failed: ${run.stderr.trim().slice(-300) || "no output"}`
                      : `${refusal.error}${refusal.hint === undefined ? "" : ` — ${refusal.hint}`}`
                  );
                }
                const result = lookResultSchema.parse(run.json);
                const images: { page: number; path: string; ref: string }[] =
                  [];
                for (const item of result.items) {
                  for (const image of item.images) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- One picture at a time keeps the step's memory flat.
                    const bytes = await readSandboxFileWithin(
                      sandbox,
                      image.file,
                      ctx.abortSignal,
                      pictureBytes
                    );
                    if (bytes === null || bytes === "oversize") {
                      throw new Error(
                        `The picture of page ${String(image.page)} of ${item.path} is missing or too large: look again with fewer pages or a region.`
                      );
                    }
                    images.push({
                      page: image.page,
                      path: item.path,
                      ref: rememberLookImage(
                        ctx.session.id,
                        Buffer.from(bytes).toString("base64")
                      ),
                    });
                  }
                }
                const seen = {
                  images,
                  items: result.items.map((item) => ({
                    kind: item.kind,
                    pages: item.images.map((image) => ({
                      gridStep: image.grid_step,
                      page: image.page,
                      region: image.region,
                      textChars: image.text_chars,
                      view: image.view,
                    })),
                    pagesTotal: item.pages_total,
                    path: item.path,
                    unit: item.unit,
                  })),
                  next: result.next,
                  truncated: result.truncated,
                  warnings: result.warnings,
                };
                return input.note === undefined
                  ? seen
                  : { note: input.note, ...seen };
              } finally {
                await sandbox
                  .removePath({ force: true, path: out, recursive: true })
                  .catch(() => undefined);
              }
            },
            toModelOutput(output) {
              const { images, ...seen } = output;
              const pages = output.items.flatMap((item) =>
                item.pages.map((page) => ({ ...page, item }))
              );
              const textLayer = pages.some(
                (page) =>
                  page.item.kind === "pdf" &&
                  (page.textChars ?? 0) > 200 &&
                  page.gridStep === null &&
                  page.region === null
              );
              return toolOutput.content([
                toolOutputPart.text(
                  `${JSON.stringify(seen)}${textLayer ? "\nThere is a text layer: `brokit pdf text` reads it exactly." : ""}`
                ),
                ...images.flatMap((image) => {
                  const shown = pages.find(
                    (page) =>
                      page.item.path === image.path && page.page === image.page
                  );
                  const name = image.path.split("/").at(-1) ?? image.path;
                  const notes: string[] = [];
                  if (shown?.region) {
                    notes.push(`область ${shown.region.join(",")}`);
                  }
                  if (shown?.gridStep) {
                    notes.push(
                      `сетка через ${String(shown.gridStep)} ${shown.item.unit}`
                    );
                  }
                  return [
                    toolOutputPart.text(
                      `Снимок: ${name} стр. ${String(image.page)}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`
                    ),
                    toolOutputPart.text(
                      `[bro-look-image:${image.ref}|${String(image.page)}|${encodeURIComponent(image.path)}]`
                    ),
                  ];
                }),
              ]);
            },
          })
        : null,
  },
});
