import { ClientError } from "eve/client";
import { z } from "zod";
import { type FileRefusal, webMessageFiles } from "@shared/chat/web-files";

/**
 * What the attach button, paste and drop take in the files pilot: photos the
 * model reads and the documents the task agent opens. HEIC stays out (iOS
 * Safari hands the picker's photos over as JPEG when the list has no HEIC),
 * so do RAR and 7z (no tool opens them); detached signatures (`.sig`,
 * `.p7s`) come in beside the files they sign. The server decides the types;
 * this list only decides what the composer offers.
 */
export const pilotAccept = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  "application/pdf",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".csv",
  ".tsv",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".txt",
  ".md",
  ".json",
  ".xml",
  ".zip",
  ".sig",
  ".p7s",
].join(",");

function megabytes(bytes: number) {
  return String(bytes / 1024 / 1024);
}

const fileTooLarge = `больше ${megabytes(webMessageFiles.maxFileSize)} МБ — такой не отправить.`;

const refusalTexts = {
  accept:
    "Такой файл не отправить. Подойдут фото JPEG, PNG, WebP и GIF, PDF, документы Word, Excel, PowerPoint и OpenDocument, CSV, TXT и ZIP. Фото HEIC сохрани как JPEG.",
  max_file_size: `Файл ${fileTooLarge}`,
  max_files: `За раз — не больше ${String(webMessageFiles.maxFiles)} файлов.`,
  max_total_size: `Вместе файлы больше ${megabytes(webMessageFiles.maxTotalSize)} МБ — отправь их в нескольких сообщениях.`,
  read: "Не получилось прочитать файл. Попробуй ещё раз.",
} as const satisfies Readonly<Record<FileRefusal | "read", string>>;

/** Why the composer left a file out, in Bro's words. */
export function refusalText(code: FileRefusal | "read") {
  return refusalTexts[code];
}

/**
 * A message the chat did not send because it could not send one now: no
 * request left the browser, so the composer keeps it.
 */
export class MessageNotSent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageNotSent";
  }
}

const refusedFileSchema = z.object({
  violations: z.array(z.object({ filename: z.string().min(1).optional() })),
});

function refusedFileName(body: string) {
  try {
    return refusedFileSchema.safeParse(JSON.parse(body)).data?.violations[0]
      ?.filename;
  } catch {
    return undefined;
  }
}

/**
 * What the person reads when a message failed, and whether the composer
 * keeps it. Only a refused request (eve's `ClientError` from the POST, or a
 * send the chat could not make) means nothing arrived; any other failure may
 * come after eve took the message, and sending it again would repeat it.
 */
export function sendFailure(error: Error) {
  if (error instanceof MessageNotSent) {
    return { keep: true, text: "Сообщение не отправилось. Попробуй ещё раз." };
  }
  if (!(error instanceof ClientError)) {
    return {
      keep: false,
      text: "Связь прервалась — проверь, дошло ли сообщение.",
    };
  }
  if (error.status === 413) {
    const name = refusedFileName(error.body);
    return {
      keep: true,
      text:
        name === undefined
          ? "Сообщение слишком большое — отправь файлы в нескольких сообщениях."
          : `Файл «${name}» ${fileTooLarge}`,
    };
  }
  if (error.status === 415) {
    return { keep: true, text: "Такой тип файла Bro не принял." };
  }
  return { keep: true, text: "Сообщение не отправилось. Попробуй ещё раз." };
}
