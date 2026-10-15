import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";
import { mediaTypeForName } from "@agent/lib/inbound-media/media-type";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import type { FilesSummary, TesterTurnKind } from "../journal.ts";
import { withRetry } from "../retry.ts";
import { gateVerdict, turnGateSchema, type TurnGate } from "./suite.ts";

/**
 * What a files case leaves for its checks (`check.py`): every reply and
 * question card of Bro by turn, the condition each gated turn met or not,
 * and every file Bro sent, downloaded into `<out>/<case>/received/` and
 * listed in `<out>/<case>/files-run.json`.
 *
 * Links are taken from the stream before the journal masks it (masking
 * could break a link's `sig`) and kept in memory only; the disk holds each
 * file's path without its query. A shared file (`/eve/v1/sandbox-files/…`)
 * and any outside link are fetched without the session cookie: the first
 * answer is a redirect to a presigned Object Storage URL. Only Bro's own
 * `/artifacts/<id>` gets the cookie, and a redirect there means the
 * session is gone. A download that fails is recorded, never fails the case.
 */

const countSchema = z.number().int().nonnegative();
const turnSchema = countSchema.nullable();
const sourceSchema = z.enum(["artifact", "attachment", "link", "text"]);

type DownloadSource = z.infer<typeof sourceSchema>;

const filesRunSchema = z.object({
  version: z.literal(1),
  caseId: z.string(),
  startedAt: z.string(),
  timeZone: z.string(),
  host: z.string(),
  fixtures: z.object({
    dir: z.string(),
    manifestSha256: z.string().nullable(),
  }),
  turns: z.array(
    z.object({
      ordinal: countSchema,
      turn: turnSchema,
      kind: z.string(),
      text: z.string(),
      sentAt: z.string(),
      sessionId: z.string(),
    })
  ),
  gates: z.array(
    z.object({
      turn: countSchema,
      kind: turnGateSchema.shape.kind,
      optional: z.boolean(),
      met: z.boolean(),
      question: z.string().nullable(),
    })
  ),
  /** The turn a stopped gate left to the tester's `send --kind answer`. */
  pendingGate: z.object({ turn: countSchema, text: z.string() }).nullable(),
  replies: z.array(
    z.object({
      turn: turnSchema,
      at: z.string(),
      text: z.string(),
      attachments: countSchema,
      sessionId: z.string(),
    })
  ),
  questions: z.array(
    z.object({ turn: turnSchema, at: z.string(), prompt: z.string() })
  ),
  received: z.array(
    z.object({
      turn: turnSchema,
      at: z.string(),
      name: z.string(),
      shownName: z.string().nullable(),
      mediaType: z.string(),
      bytes: countSchema,
      sha256: z.string(),
      file: z.string(),
      source: sourceSchema,
      urlPath: z.string(),
    })
  ),
  failedDownloads: z.array(
    z.object({ turn: turnSchema, urlPath: z.string(), reason: z.string() })
  ),
});

type FilesRun = z.infer<typeof filesRunSchema>;

const missingFileSchema = z.object({ code: z.literal("ENOENT") });

/** A file bigger than this is not a document a person gets in a chat. */
const downloadCapBytes = 60 * 1024 * 1024;
const downloadTimeoutMs = 120_000;

/** Bro's file links, as `withExactSharedLinks` leaves them in the text. */
const sharedLinkInText =
  /https?:\/\/[^\s/<>"']+\/eve\/v1\/sandbox-files\/[\da-f]{24}\/[^\s?#<>"']*\?sig=[\w-]+/gu;
/** Bro's private artifacts, written into the text as `/artifacts/<id>`. */
const artifactInText =
  /(?:https?:\/\/[^\s/<>"'()]+)?\/artifacts\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/giu;
/** An extension worth keeping on a saved file. */
const savedExtension = /^\.[a-z0-9]{1,8}$/u;

/** The extension of a file whose link names none (an artifact's id). */
const extensionsByType: ReadonlyMap<string, string> = new Map([
  ["application/pdf", ".pdf"],
  ["application/vnd.ms-excel", ".xls"],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pptx",
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsx",
  ],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".docx",
  ],
  ["application/zip", ".zip"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["text/calendar", ".ics"],
  ["text/csv", ".csv"],
  ["text/plain", ".txt"],
  ["text/vcard", ".vcf"],
]);

class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

interface QueuedDownload {
  readonly at: string;
  readonly shownName: string | null;
  readonly source: DownloadSource;
  readonly turn: number | null;
  readonly url: URL;
}

async function sha256Of(path: string) {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch (error) {
    if (missingFileSchema.safeParse(error).success) return null;
    throw error;
  }
}

/** The decoded last segment of a link's path: the file's name. */
function linkName(url: URL) {
  const segment = url.pathname.split("/").at(-1) ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Reads a response body, refusing one past `downloadCapBytes`. */
async function cappedBody(response: Response) {
  const reader = response.body?.getReader();
  if (reader === undefined) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read chunk after chunk
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > downloadCapBytes) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the read stops here
      await reader.cancel();
      throw new DownloadError(
        `файл больше ${String(downloadCapBytes / 1024 / 1024)} МБ`
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export class FilesCollector {
  readonly #cookie: string | undefined;
  readonly #dir: string;
  readonly #host: URL;
  readonly #mask: (text: string) => string;
  readonly #queue: QueuedDownload[] = [];
  readonly #seen = new Set<string>();
  readonly #state: FilesRun;
  /** The turn Bro's replies now belong to; null during the cleanup. */
  #current: number | null;

  private constructor(
    dir: string,
    state: FilesRun,
    context: {
      readonly cookie: string | undefined;
      readonly host: string;
      readonly mask: (text: string) => string;
    }
  ) {
    this.#dir = dir;
    this.#state = state;
    this.#cookie = context.cookie;
    this.#host = new URL(context.host);
    this.#mask = context.mask;
    this.#current = state.turns.at(-1)?.turn ?? null;
  }

  /**
   * The collector of a case's directory: the run `files-run.json` records,
   * when a later command continues it, or a fresh one.
   */
  static async open(
    paths: { readonly caseId: string; readonly dir: string },
    context: {
      readonly cookie: string | undefined;
      readonly fixturesDir: string;
      readonly host: string;
      readonly mask: (text: string) => string;
      readonly startedAt: string;
      readonly timeZone: string;
    }
  ) {
    let state: FilesRun;
    try {
      state = filesRunSchema.parse(
        JSON.parse(await readFile(join(paths.dir, "files-run.json"), "utf8"))
      );
    } catch (error) {
      if (!missingFileSchema.safeParse(error).success) throw error;
      state = {
        version: 1,
        caseId: paths.caseId,
        startedAt: context.startedAt,
        timeZone: context.timeZone,
        host: context.host,
        fixtures: {
          dir: context.fixturesDir,
          manifestSha256: await sha256Of(
            join(context.fixturesDir, "manifest.json")
          ),
        },
        turns: [],
        gates: [],
        pendingGate: null,
        replies: [],
        questions: [],
        received: [],
        failedDownloads: [],
      };
    }
    return new FilesCollector(paths.dir, state, context);
  }

  /** Takes Bro's replies, question cards and file links from one event. */
  observe(sessionId: string, event: MessageStreamEvent) {
    const turn = this.#current;
    const { at } = event.meta;
    if (event.type === "input.requested") {
      for (const request of event.data.requests) {
        if (request.kind !== "question") continue;
        this.#state.questions.push({
          at,
          prompt: this.#mask(request.prompt),
          turn,
        });
      }
      return;
    }
    if (event.type !== "action.result" || event.data.status !== "completed") {
      return;
    }
    const delivered = sendMessageToolResultSchema.safeParse(event.data.result);
    if (!delivered.success) return;
    const { output } = delivered.data;
    if (output.kind === "link") {
      this.#state.replies.push({
        at,
        attachments: 0,
        sessionId,
        text: "",
        turn,
      });
      this.#enqueue(output.url, "link", null, turn, at);
      return;
    }
    const text = output.text ?? "";
    const attachments = output.attachments ?? [];
    this.#state.replies.push({
      at,
      attachments: attachments.length,
      sessionId,
      text: this.#mask(text),
      turn,
    });
    for (const attachment of attachments) {
      this.#enqueue(
        attachment.url,
        "attachment",
        attachment.name ?? null,
        turn,
        at
      );
    }
    for (const [link] of text.matchAll(sharedLinkInText)) {
      this.#enqueue(link, "text", null, turn, at);
    }
    for (const [link] of text.matchAll(artifactInText)) {
      this.#enqueue(link, "artifact", null, turn, at);
    }
  }

  /**
   * Notes what the tester sent: a scripted turn makes its replies that
   * turn's, an answer to a stopped gate counts as the gated turn, and the
   * cleanup's replies belong to no turn.
   */
  noteTurn(note: {
    readonly kind: TesterTurnKind;
    readonly sentAt: string;
    readonly sessionId: string;
    readonly text: string;
    readonly turn: number | undefined;
  }) {
    const { pendingGate } = this.#state;
    if (note.kind === "script" && note.turn !== undefined) {
      this.#current = note.turn;
    } else if (note.kind === "answer" && pendingGate !== null) {
      this.#current = pendingGate.turn;
      this.#state.pendingGate = null;
    } else if (note.kind === "cleanup") {
      this.#current = null;
    }
    this.#state.turns.push({
      ordinal: this.#state.turns.length,
      turn: this.#current,
      kind: note.kind,
      text: this.#mask(note.text),
      sentAt: note.sentAt,
      sessionId: note.sessionId,
    });
  }

  /**
   * Whether turn `turn`'s condition holds over Bro's replies to the turn
   * before it; the verdict is recorded for `consent_asked`.
   */
  gate(gate: TurnGate, turn: number) {
    const replies = this.#state.replies
      .filter((reply) => reply.turn === this.#current)
      .map((reply) => reply.text);
    const verdict = gateVerdict(gate, replies);
    this.#state.gates.push({
      turn,
      kind: gate.kind,
      optional: gate.optional,
      met: verdict.met,
      question: verdict.question,
    });
    return verdict;
  }

  /** The case stopped before turn `turn`, which the tester sends by hand. */
  stopAt(turn: number, text: string) {
    this.#state.pendingGate = { turn, text: this.#mask(text) };
  }

  /**
   * Downloads what the stream named since the last flush, then writes
   * `files-run.json`. `log` takes the journal's lines.
   */
  async flush(log: (line: string) => Promise<void>) {
    await mkdir(join(this.#dir, "received"), { recursive: true });
    for (
      let item = this.#queue.shift();
      item !== undefined;
      item = this.#queue.shift()
    ) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one download at a time, bounded memory
      await this.#download(item, log);
    }
    // Through the schema, so the keys keep one order whichever command
    // wrote the file.
    await writeFile(
      join(this.#dir, "files-run.json"),
      `${JSON.stringify(filesRunSchema.parse(this.#state), null, 2)}\n`
    );
  }

  /** The record's view of the files (`driver.files`), checks aside. */
  summary(): Omit<FilesSummary, "checks"> {
    return {
      failedDownloads: this.#state.failedDownloads.length,
      gates: this.#state.gates.map(({ met, turn }) => ({ met, turn })),
      received: this.#state.received.length,
    };
  }

  #enqueue(
    link: string,
    source: DownloadSource,
    shownName: string | null,
    turn: number | null,
    at: string
  ) {
    const url = URL.parse(link, this.#host);
    if (url === null || this.#seen.has(url.href)) return;
    // Another site's `/artifacts/…` is not Bro's: it gets no cookie and is
    // not one of Bro's files.
    if (source === "artifact" && url.origin !== this.#host.origin) return;
    this.#seen.add(url.href);
    this.#queue.push({ at, shownName, source, turn, url });
  }

  /** Bro's own artifact, which only the signed-in session may read. */
  #ownArtifact(url: URL) {
    return (
      url.origin === this.#host.origin && url.pathname.startsWith("/artifacts/")
    );
  }

  async #fetch(url: URL) {
    const signal = AbortSignal.timeout(downloadTimeoutMs);
    if (!this.#ownArtifact(url)) {
      // No cookie: the link's own signature opens it, and its redirect
      // goes to Object Storage.
      const response = await fetch(url, { redirect: "follow", signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new DownloadError(`HTTP ${String(response.status)}`);
      }
      return response;
    }
    if (this.#cookie === undefined) {
      throw new DownloadError("нет cookie сессии для /artifacts/");
    }
    const response = await fetch(url, {
      headers: { cookie: this.#cookie, origin: this.#host.origin },
      redirect: "manual",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DownloadError(
        response.status >= 300 && response.status < 400
          ? "перенаправление на вход: сессия драйвера не действует"
          : `HTTP ${String(response.status)}`
      );
    }
    return response;
  }

  async #download(item: QueuedDownload, log: (line: string) => Promise<void>) {
    const urlPath = item.url.pathname;
    let body: Buffer;
    let headerType: string;
    try {
      ({ body, headerType } = await withRetry(
        {
          idempotent: true,
          label: "скачивание файла",
          log: (line) => log(`== драйвер: ${line}`),
        },
        async () => {
          const response = await this.#fetch(item.url);
          return {
            body: await cappedBody(response),
            headerType:
              (response.headers.get("content-type") ?? "")
                .split(";")[0]
                ?.trim()
                .toLowerCase() ?? "",
          };
        }
      ));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#state.failedDownloads.push({ reason, turn: item.turn, urlPath });
      await log(`!! драйвер: файл ${urlPath} не скачан — ${reason}`);
      return;
    }
    const sha256 = createHash("sha256").update(body).digest("hex");
    // A file sent again keeps the turn it first came in.
    if (this.#state.received.some((known) => known.sha256 === sha256)) return;
    const name = linkName(item.url);
    const mediaType =
      headerType.length > 0 && !headerType.endsWith("octet-stream")
        ? headerType
        : (mediaTypeForName(name) ?? "application/octet-stream");
    const named = extname(name).toLowerCase();
    const extension = savedExtension.test(named)
      ? named
      : (extensionsByType.get(mediaType) ?? "");
    const file = `received/${item.turn === null ? "c" : String(item.turn)}-${String(this.#state.received.length + 1)}-${sha256.slice(0, 8)}${extension}`;
    await writeFile(join(this.#dir, file), body);
    this.#state.received.push({
      turn: item.turn,
      at: item.at,
      name,
      shownName: item.shownName,
      mediaType,
      bytes: body.byteLength,
      sha256,
      file,
      source: item.source,
      urlPath,
    });
    await log(
      `== драйвер: файл ${name} (${String(body.byteLength)} байт) → ${file}`
    );
  }
}
