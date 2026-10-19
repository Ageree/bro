import { z } from "zod";
import { env } from "@shared/environment";
import type { Prompt, PromptMessage } from "@agent/lib/model/prompt";
import { namedAttachmentPaths } from "@agent/lib/sandbox/inbox";
import { annotationSchema, annotationsFor } from "./annotations";
import { pdfFacts } from "./pdf";

/**
 * The files the person sent, as the files pilot hands them to the model
 * (`stagedFilesMiddleware` in `agent/lib/model/direct.ts`). eve stages each
 * file into the sandbox and keeps its path as the hydrated part's
 * `filename` (`harness/attachment-staging.js`), but the model is shown an
 * inline photo or PDF without it, so each one gets eve's own line
 * `Attached file <path> (<type>)` next to it: Bro can hand the original to
 * the task agent. RouterAI parses a PDF part on every call (5–10 s for a
 * scan) and fails the whole call on a PDF with an opening password, so a
 * PDF of an earlier turn goes as its line alone, one of this turn keeps its
 * part and reuses the parse of the step before (`annotations.ts`), and an
 * encrypted one never goes.
 *
 * A photo of an earlier turn goes as its line alone only in the pilot
 * EARLIER_PHOTOS_WORKSPACES (`earlierPhotos`): RunInfra takes no picture, so
 * a call that carries one goes to RouterAI (`routerai/runinfra.ts`), and a
 * photo kept in the history sent every later step of the conversation there,
 * 2–4 s slower to the first token (19.10).
 */

type UserPart = Extract<PromptMessage, { role: "user" }>["content"][number];
type FilePart = Extract<UserPart, { type: "file" }>;

/** eve's line for a staged image past what it inlines. */
const bigImageLine =
  /^Attached file (\/workspace\/attachments\/[\da-f]{16}\/[\w.-]+) \((image\/[\w.+-]+)\)$/u;
const bigImageNote = " — картинка больше 3 МБ: ты её не видишь";
const encryptedNote = " — PDF зашифрован: ты его не видишь";
const earlierPhotoNote =
  " — фото из прошлого сообщения: сейчас ты его не видишь, о нём — твой прежний ответ; нужна новая деталь с него — поручи помощнику посмотреть этот файл";

/** The PDFs' facts by path: the hash in the path names the bytes. */
const factsByPath = new Map<string, ReturnType<typeof pdfFacts>>();
const maximumFacts = 500;
/**
 * The PDFs a model call failed on, by path (`markUnreadablePdfs`): they go
 * as their lines from then on, as an earlier turn's do.
 */
const unreadable = new Set<string>();
const maximumUnreadable = 500;

const ownAnnotationsSchema = z.object({
  openrouter: z.object({ annotations: z.array(annotationSchema) }),
});

/**
 * Whether EARLIER_PHOTOS_WORKSPACES names the workspace by id or `*`: a pure
 * read of the environment, so every step can ask it.
 */
export function earlierPhotosPilot(workspaceId: string) {
  const list = env.EARLIER_PHOTOS_WORKSPACES ?? [];
  return list.includes("*") || list.includes(workspaceId);
}

/** Whether `value` is a path eve's staging made. */
export function isStagedPath(value: string | undefined): value is string {
  return value !== undefined && namedAttachmentPaths(value)[0] === value;
}

/**
 * Where the current turn begins: the last assistant message with a user
 * message after it (−1 when there is none). A user message before it is
 * an earlier turn's.
 */
export function currentTurnStart(prompt: Prompt) {
  let userAfter = false;
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const role = prompt[index]?.role;
    if (role === "user") userAfter = true;
    if (role === "assistant" && userAfter) return index;
  }
  return -1;
}

/**
 * The staged PDFs a prompt carries as parts, which the provider parses: on
 * a prompt `withStagedFiles` made, this turn's.
 */
export function inlinePdfPaths(prompt: Prompt) {
  return prompt.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) =>
          part.type === "file" &&
          part.mediaType === "application/pdf" &&
          isStagedPath(part.filename)
            ? [part.filename]
            : []
        )
      : []
  );
}

/**
 * Remembers PDFs the provider could not parse. Such a call fails its turn
 * without an answer, so the next turn's prompt has no assistant message
 * after the PDF and would count it as its own, inline, failing again: a
 * corrupt PDF would fail every turn after it. Remembered, it goes as its
 * line, which Bro hands to the task agent. Process memory only: a restart
 * costs one more failure.
 */
export function markUnreadablePdfs(paths: readonly string[]) {
  for (const path of paths) {
    unreadable.delete(path);
    unreadable.add(path);
  }
  for (const oldest of unreadable) {
    if (unreadable.size <= maximumUnreadable) break;
    unreadable.delete(oldest);
  }
}

function attachedLine(path: string, label: string) {
  return { text: `Attached file ${path} (${label})`, type: "text" } as const;
}

function factsOf(path: string, data: Uint8Array | string) {
  const known = factsByPath.get(path);
  if (known !== undefined) return known;
  const bytes = data instanceof Uint8Array ? data : Buffer.from(data, "base64");
  const facts = pdfFacts(bytes);
  factsByPath.set(path, facts);
  for (const [oldest] of factsByPath) {
    if (factsByPath.size <= maximumFacts) break;
    factsByPath.delete(oldest);
  }
  return facts;
}

/** What one PDF part became, and the count it adds to. */
function pdfParts(
  part: FilePart,
  path: string,
  data: Uint8Array | string,
  earlier: boolean
) {
  const { encrypted, pages } = factsOf(path, data);
  const label =
    pages === undefined
      ? "application/pdf"
      : `application/pdf, ${String(pages)} стр.`;
  if (encrypted) {
    return {
      kind: "encrypted",
      parts: [
        {
          text: `${attachedLine(path, label).text}${encryptedNote}`,
          type: "text",
        },
      ],
    } as const;
  }
  if (earlier || unreadable.has(path)) {
    return { kind: "earlier", parts: [attachedLine(path, label)] } as const;
  }
  return {
    kind: "current",
    parts: [part, attachedLine(path, label)],
  } as const;
}

/**
 * The prompt with each staged file's path line, the PDFs of earlier turns
 * (and their photos with `earlierPhotos`), the encrypted ones and those a call failed on (`markUnreadablePdfs`) as
 * lines alone, eve's line of a photo too large to
 * inline saying the model does not see it, and the parse of this turn's
 * PDFs on the assistant message after them; the same prompt when nothing
 * changes. Within a turn every step gets the same transform; the next turn
 * turns this turn's PDFs into lines, one cache miss at the boundary.
 */
export function withStagedFiles(
  prompt: Prompt,
  options: { readonly earlierPhotos?: boolean } = {}
) {
  const cut = currentTurnStart(prompt);
  const pdfs = { annotated: 0, current: 0, earlier: 0, encrypted: 0 };
  /** This turn's PDFs kept inline, by the index of their message. */
  const kept = new Map<number, string[]>();
  let changed = false;
  const transformed: Prompt = prompt.map((message, index) => {
    if (message.role !== "user") return message;
    const content = message.content.flatMap((part): UserPart[] => {
      if (part.type === "text") {
        if (!bigImageLine.test(part.text)) return [part];
        return [{ ...part, text: `${part.text}${bigImageNote}` }];
      }
      if (!isStagedPath(part.filename)) return [part];
      const path = part.filename;
      if (
        options.earlierPhotos === true &&
        index < cut &&
        part.mediaType.startsWith("image/")
      ) {
        return [
          {
            text: `${attachedLine(path, part.mediaType).text}${earlierPhotoNote}`,
            type: "text",
          },
        ];
      }
      if (part.mediaType !== "application/pdf" || part.data.type !== "data") {
        return [part, attachedLine(path, part.mediaType)];
      }
      const pdf = pdfParts(part, path, part.data.data, index < cut);
      pdfs[pdf.kind] += 1;
      if (pdf.kind === "current")
        kept.set(index, [...(kept.get(index) ?? []), path]);
      return [...pdf.parts];
    });
    if (
      content.length === message.content.length &&
      content.every((part, at) => part === message.content[at])
    ) {
      return message;
    }
    changed = true;
    return { ...message, content };
  });
  for (const [index, paths] of kept) {
    const answer = transformed.findIndex(
      (message, at) => at > index && message.role === "assistant"
    );
    const message = transformed[answer];
    if (message?.role !== "assistant") continue;
    const own =
      ownAnnotationsSchema.safeParse(message.providerOptions).data?.openrouter
        .annotations ?? [];
    const added = annotationsFor(paths).filter(
      (annotation) =>
        !own.some((mine) => mine.file.hash === annotation.file.hash)
    );
    if (added.length === 0) continue;
    pdfs.annotated += added.length;
    changed = true;
    transformed[answer] = {
      ...message,
      providerOptions: {
        ...message.providerOptions,
        openrouter: {
          ...message.providerOptions?.openrouter,
          annotations: [...own, ...added],
        },
      },
    };
  }
  return { pdfs, prompt: changed ? transformed : prompt };
}
