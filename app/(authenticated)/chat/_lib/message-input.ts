import type { FilePart, FileUIPart, UserContent } from "ai";
import type { PromptInputMessage } from "@web/components/ai-elements/prompt-input";

export function messageContent(message: PromptInputMessage) {
  const text = message.text.trim();
  if (message.files.length === 0) return text;

  const parts: UserContent = [];
  if (text.length > 0) parts.push({ text, type: "text" });
  parts.push(...messageFileParts(message.files));
  return parts;
}

/**
 * The decoded bytes of the images one message shows as thumbnails: eve keeps
 * a `data:` URL whole in `message.received`, so such a file goes back to the
 * browser in the session stream and in every load of the history.
 */
const previewImageBytes = 1024 * 1024;

const base64DataUrl = /^data:[^,]*;base64,/u;

/**
 * A message's files as eve takes them: the original bytes always, as a
 * `data:` URL only for images within the thumbnails' budget, otherwise as
 * the bare base64 after the comma, which eve does not echo. A file the
 * browser left untyped goes as `application/octet-stream` (eve refuses an
 * empty type) and is told apart by its name.
 */
function messageFileParts(
  files: readonly Pick<FileUIPart, "filename" | "mediaType" | "url">[]
): FilePart[] {
  let previewBudget = previewImageBytes;
  return files.map((file) => {
    const mediaType =
      file.mediaType.length > 0 ? file.mediaType : "application/octet-stream";
    const prefix = base64DataUrl.exec(file.url)?.[0];
    let data = file.url;
    if (prefix !== undefined) {
      const base64 = file.url.slice(prefix.length);
      const bytes = decodedBytes(base64);
      if (mediaType.startsWith("image/") && bytes <= previewBudget) {
        previewBudget -= bytes;
      } else {
        data = base64;
      }
    }
    return { data, filename: file.filename, mediaType, type: "file" };
  });
}

function decodedBytes(base64: string) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function chatTitle(message: PromptInputMessage) {
  const text = message.text.trim();
  if (text) return text.slice(0, 240);
  return message.files[0]?.filename?.slice(0, 240) ?? "New chat";
}
