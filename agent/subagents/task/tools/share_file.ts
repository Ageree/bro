import { defineTool } from "eve/tools";
import { z } from "zod";
import { resolveMediaType } from "@agent/lib/inbound-media/media-type";
import {
  maximumSharedFileBytes,
  shareSandboxFile,
  sharedFileName,
} from "@agent/lib/sandbox/files";

/** What a file is by its name, when its bytes do not say (text, csv, office). */
const mediaTypesByExtension: ReadonlyMap<string, string> = new Map([
  [".csv", "text/csv"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [
    ".pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [".zip", "application/zip"],
]);

function mediaTypeOf(name: string, bytes: Uint8Array) {
  const extension = /\.[a-z\d]{1,8}$/iu.exec(name)?.[0]?.toLowerCase();
  const byName =
    extension === undefined ? undefined : mediaTypesByExtension.get(extension);
  // An office document is a zip by its bytes; its name says which one.
  return (
    byName ?? resolveMediaType(bytes, undefined) ?? "application/octet-stream"
  );
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
    const sandbox = await ctx.getSandbox();
    // The size first: a huge file must not be read into Bro's memory.
    const size = await sandbox.run({
      command: 'stat -c %s -- "$P"',
      env: { P: path },
    });
    if (size.exitCode !== 0) throw new Error(`There is no file at ${path}.`);
    if (Number(size.stdout.trim()) > maximumSharedFileBytes) {
      throw new Error(
        `The file ${path} is over 10 MB: compress it or split it into parts.`
      );
    }
    const bytes = await sandbox.readBinaryFile({ path });
    if (bytes === null) throw new Error(`There is no file at ${path}.`);
    if (bytes.byteLength === 0) throw new Error(`The file ${path} is empty.`);
    if (bytes.byteLength > maximumSharedFileBytes) {
      throw new Error(
        `The file ${path} is over 10 MB: compress it or split it into parts.`
      );
    }
    const fileName = sharedFileName(name ?? path);
    const shared = await shareSandboxFile({
      bytes,
      mediaType: mediaTypeOf(fileName, bytes),
      name: fileName,
    });
    return {
      bytes: shared.bytes,
      mediaType: shared.mediaType,
      name: shared.name,
      url: shared.url,
    };
  },
});
