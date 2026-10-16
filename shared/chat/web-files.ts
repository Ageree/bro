/**
 * A web chat message's files: the composer refuses more, and eve's message
 * routes refuse a body that could hold more. `maxFileSize` equals the web
 * channel's upload policy, which answers 413 for a bigger file
 * (`agent/channels/eve.ts`).
 */
export const webMessageFiles = {
  maxFileSize: 20 * 1024 * 1024,
  maxFiles: 10,
  maxTotalSize: 40 * 1024 * 1024,
} as const;

/**
 * The body of eve's message routes: the files' total as base64 (53.4 MiB)
 * with the text and the JSON around it.
 */
export const webMessageBodyBytes = 64 * 1024 * 1024;

/** Why a file was left out of a message, most telling first. */
export type FileRefusal =
  | "accept"
  | "max_file_size"
  | "max_files"
  | "max_total_size";

const refusalOrder: readonly FileRefusal[] = [
  "accept",
  "max_file_size",
  "max_files",
  "max_total_size",
];

/**
 * Whether a file fits an `accept` list as a file input reads it: `.ext` by
 * the name's ending (browsers leave the type of `.md` or `.docx` empty),
 * `type/*` by the type's prefix, anything else by the exact type.
 */
function fileMatchesAccept(
  accept: string | undefined,
  file: { readonly name: string; readonly type: string }
) {
  const tokens = (accept ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return tokens.some((token) => {
    if (token.startsWith(".")) return name.endsWith(token);
    if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
    return type === token;
  });
}

/**
 * The files that may join a message, in order: each is checked for its type,
 * its size, the count and the total with the files already `held`; a file
 * that fails is skipped and the rest still come in. `refusal` names the most
 * telling reason any file was left out, so one batch raises one notice.
 */
export function admitFiles<
  T extends {
    readonly name: string;
    readonly size: number;
    readonly type: string;
  },
>(
  files: readonly T[],
  limits: {
    readonly accept?: string;
    readonly held?: { readonly bytes: number; readonly count: number };
    readonly maxFileSize?: number;
    readonly maxFiles?: number;
    readonly maxTotalSize?: number;
  }
): { readonly admitted: readonly T[]; readonly refusal?: FileRefusal } {
  let count = limits.held?.count ?? 0;
  let bytes = limits.held?.bytes ?? 0;
  const admitted: T[] = [];
  const refused = new Set<FileRefusal>();
  for (const file of files) {
    if (!fileMatchesAccept(limits.accept, file)) {
      refused.add("accept");
    } else if (
      limits.maxFileSize !== undefined &&
      file.size > limits.maxFileSize
    ) {
      refused.add("max_file_size");
    } else if (limits.maxFiles !== undefined && count >= limits.maxFiles) {
      refused.add("max_files");
    } else if (
      limits.maxTotalSize !== undefined &&
      bytes + file.size > limits.maxTotalSize
    ) {
      refused.add("max_total_size");
    } else {
      admitted.push(file);
      count += 1;
      bytes += file.size;
    }
  }
  const refusal = refusalOrder.find((reason) => refused.has(reason));
  return refusal === undefined ? { admitted } : { admitted, refusal };
}
