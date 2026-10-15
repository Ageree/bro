import { defineTool } from "eve/tools";
import { z } from "zod";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { resolveMediaType } from "@agent/lib/inbound-media/media-type";
import {
  maximumSharedFileBytes,
  shareSandboxFile,
  sharedFileName,
  taskFilesShareBytes,
} from "@agent/lib/sandbox/files";
import { taskFilesOfCaller } from "@agent/lib/sandbox/pilot";

/** What a file is by its name, when its bytes do not say (text, csv, office). */
const mediaTypesByExtension: ReadonlyMap<string, string> = new Map([
  [".csv", "text/csv"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [".ics", "text/calendar"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".odp", "application/vnd.oasis.opendocument.presentation"],
  [".ods", "application/vnd.oasis.opendocument.spreadsheet"],
  [".odt", "application/vnd.oasis.opendocument.text"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [
    ".pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".vcf", "text/vcard"],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [".xml", "application/xml"],
  [".zip", "application/zip"],
]);

function mediaTypeOf(name: string, bytes: Uint8Array) {
  const extension = /\.[a-z\d]{1,8}$/iu.exec(name)?.[0]?.toLowerCase();
  const byName =
    extension === undefined ? undefined : mediaTypesByExtension.get(extension);
  // The bytes say what a file is, whatever its name; the name speaks only
  // for what they do not tell, like an office document (a zip inside).
  return (
    resolveMediaType(bytes, undefined) ?? byName ?? "application/octet-stream"
  );
}

/**
 * The file's bytes, or undefined once it runs past `maximumBytes`: the read
 * stops there, so a file the sandbox grew or swapped after it was named
 * cannot fill Bro's memory.
 */
async function readWithin(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number
) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The file arrives as a sequence of chunks.
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > maximumBytes) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The read ends here.
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
}

export default defineTool({
  description:
    "Hand a finished file from the sandbox to Bro for the person: stores it and returns a link. Put every link you get, on its own line, in your final answer; Bro attaches the files to its message. Up to 10 MB per file.",
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The file name the person sees, such as «Отчёт за сентябрь.pdf». Defaults to the file's own name."
      ),
    path: z
      .string()
      .min(1)
      .describe(
        "Path of the file in the sandbox, such as /workspace/report.pdf."
      ),
  }),
  async execute({ name, path }, ctx) {
    // The files pilot sends files up to 20 MB; the description keeps saying
    // 10 MB so the tool block stays the same outside it, and the pilot's
    // instructions say 20.
    const cap = taskFilesOfCaller(ctx)
      ? taskFilesShareBytes
      : maximumSharedFileBytes;
    const sandbox = await ctx.getSandbox();
    const stream = await sandbox.readFile({ path });
    if (stream === null) throw new Error(`There is no file at ${path}.`);
    const bytes = await readWithin(stream, cap);
    if (bytes === undefined) {
      throw new Error(
        `The file ${path} is over ${String(cap / 1024 / 1024)} MB: compress it or split it into parts.`
      );
    }
    if (bytes.byteLength === 0) throw new Error(`The file ${path} is empty.`);
    const fileName = sharedFileName(name ?? path);
    const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
    const shared = await shareSandboxFile({
      bytes,
      maximumBytes: cap,
      mediaType: mediaTypeOf(fileName, bytes),
      name: fileName,
      owner:
        caller?.principalType === "user"
          ? {
              sessionId: ctx.session.parent?.rootSessionId ?? ctx.session.id,
              workspaceId: scopeFromPrincipal(caller).workspaceId,
            }
          : undefined,
    });
    return {
      bytes: shared.bytes,
      mediaType: shared.mediaType,
      name: shared.name,
      url: shared.url,
    };
  },
});
