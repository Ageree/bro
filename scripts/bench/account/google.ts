import { z } from "zod";
import type { GoogleCall } from "./composio.ts";

/**
 * The few Google API calls fixtures need, through Composio's proxy: insert
 * and delete letters, events and one Drive file. Nothing is ever sent:
 * `messages.insert` puts a letter straight into the tester's own mailbox,
 * and events are created without guests and with `sendUpdates=none`.
 */

const gmail = "https://gmail.googleapis.com/gmail/v1/users/me";
const calendar = "https://www.googleapis.com/calendar/v3/calendars/primary";
const drive = "https://www.googleapis.com/drive/v3/files";
const driveUpload = "https://www.googleapis.com/upload/drive/v3/files";

const googleErrorSchema = z.object({
  error: z.object({ message: z.string() }),
});

async function googleResult<T>(
  result: Awaited<ReturnType<GoogleCall>>,
  schema: z.ZodType<T>,
  what: string
) {
  if (result.status < 200 || result.status >= 300) {
    const message =
      googleErrorSchema.safeParse(result.data).data?.error.message ??
      "no details";
    throw new Error(
      `${what}: Google answered ${String(result.status)} (${message}).`
    );
  }
  return schema.parse(result.data);
}

const idSchema = z.object({ id: z.string().min(1) });
const removed = z.unknown();

/** Deleted now, or gone already: a second clean must not fail on it. */
const goneStatuses = new Set([404, 410]);

interface EventTime {
  /** Local time with its offset, `2026-09-25T07:05:00+03:00`. */
  readonly dateTime: string;
  readonly timeZone: string;
}

/** The Calendar `events.insert` body fixtures send: never with attendees. */
export interface CalendarEventBody {
  readonly colorId: string;
  readonly description: string | undefined;
  readonly end: EventTime;
  readonly extendedProperties: {
    readonly private: { readonly broBench: string };
  };
  readonly location: string | undefined;
  readonly start: EventTime;
  readonly summary: string;
}

export function googleAccount(call: GoogleCall) {
  return {
    /** The tester's own address, which the fixtures write to and from. */
    async mailbox() {
      const profile = await googleResult(
        await call({ method: "GET", url: `${gmail}/profile` }),
        z.object({ emailAddress: z.string().min(3) }),
        "Gmail profile"
      );
      return profile.emailAddress;
    },

    async ensureLabel(name: string) {
      const { labels } = await googleResult(
        await call({ method: "GET", url: `${gmail}/labels` }),
        z.object({
          labels: z.array(z.object({ id: z.string(), name: z.string() })),
        }),
        "Gmail labels"
      );
      const existing = labels.find((label) => label.name === name);
      if (existing) return { created: false, id: existing.id };
      const created = await googleResult(
        await call({
          body: {
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
            name,
          },
          method: "POST",
          url: `${gmail}/labels`,
        }),
        idSchema,
        `Gmail label ${name}`
      );
      return { created: true, id: created.id };
    },

    /**
     * `dateHeader` dates an old letter by its `Date:`; a letter that is to
     * look new to Bro's background check keeps the time it was inserted.
     */
    async insertLetter(letter: {
      readonly dated: "header" | "insertion";
      readonly labelIds: readonly string[];
      readonly raw: string;
      readonly threadId: string | undefined;
    }) {
      return await googleResult(
        await call({
          // No thread is `undefined`, which JSON leaves out.
          body: {
            labelIds: letter.labelIds,
            raw: letter.raw,
            threadId: letter.threadId,
          },
          method: "POST",
          query: {
            internalDateSource:
              letter.dated === "header" ? "dateHeader" : "receivedTime",
          },
          url: `${gmail}/messages`,
        }),
        z.object({ id: z.string().min(1), threadId: z.string().min(1) }),
        "Gmail insert"
      );
    },

    /**
     * Deletes a letter for good. A grant without the full-mail scope may
     * only trash it, which Gmail empties by itself after 30 days.
     */
    async removeLetter(id: string) {
      const url = `${gmail}/messages/${encodeURIComponent(id)}`;
      const result = await call({ method: "DELETE", url });
      if (goneStatuses.has(result.status)) return "gone";
      if (result.status === 403) {
        await googleResult(
          await call({ method: "POST", url: `${url}/trash` }),
          removed,
          "Gmail trash"
        );
        return "trashed";
      }
      await googleResult(result, removed, "Gmail delete");
      return "deleted";
    },

    async removeLabel(id: string) {
      const result = await call({
        method: "DELETE",
        url: `${gmail}/labels/${encodeURIComponent(id)}`,
      });
      if (goneStatuses.has(result.status)) return;
      await googleResult(result, removed, "Gmail label delete");
    },

    async insertEvent(event: CalendarEventBody) {
      const created = await googleResult(
        await call({
          body: event,
          method: "POST",
          query: { sendUpdates: "none" },
          url: `${calendar}/events`,
        }),
        idSchema,
        "Calendar insert"
      );
      return created.id;
    },

    async removeEvent(id: string) {
      const result = await call({
        method: "DELETE",
        query: { sendUpdates: "none" },
        url: `${calendar}/events/${encodeURIComponent(id)}`,
      });
      if (goneStatuses.has(result.status)) return "gone";
      await googleResult(result, removed, "Calendar delete");
      return "deleted";
    },

    /** Uploads the content, then names the file: a media upload has no metadata. */
    async uploadDocument(document: {
      readonly content: string;
      readonly description: string;
      readonly mediaType: string;
      readonly name: string;
      readonly properties: Readonly<Record<string, string>>;
    }) {
      const { id } = await googleResult(
        await call({
          binary: {
            base64: Buffer.from(document.content).toString("base64"),
            contentType: document.mediaType,
          },
          method: "POST",
          query: { uploadType: "media" },
          url: driveUpload,
        }),
        idSchema,
        "Drive upload"
      );
      const url = `${drive}/${encodeURIComponent(id)}`;
      try {
        await googleResult(
          await call({
            body: {
              appProperties: document.properties,
              description: document.description,
              name: document.name,
            },
            method: "PATCH",
            url,
          }),
          idSchema,
          "Drive rename"
        );
      } catch (error) {
        // An untitled file the manifest never saw would outlive `clean`.
        await call({ method: "DELETE", url });
        throw error;
      }
      return id;
    },

    async removeDocument(id: string) {
      const result = await call({
        method: "DELETE",
        url: `${drive}/${encodeURIComponent(id)}`,
      });
      if (goneStatuses.has(result.status)) return "gone";
      await googleResult(result, removed, "Drive delete");
      return "deleted";
    },
  };
}
