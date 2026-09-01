import { composio } from "./composio.ts";
import { ingestArchiveDocument } from "./archive.ts";
import {
  emailToDocument,
  eventToDocument,
  gmailQuery,
  type ArchiveDocument,
} from "./archive-policy.ts";

export type AppSyncResult = { ingested: number } | { skipped: string };

export interface ArchiveSyncResult {
  gmail: AppSyncResult;
  calendar: AppSyncResult;
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

async function execute(
  slug: string,
  userId: string,
  args: Record<string, unknown>,
): Promise<{ data: Record<string, unknown> } | { skipped: string }> {
  try {
    const res = await composio().tools.execute(slug, {
      userId,
      // Composio's manual execution demands a pinned toolkit version otherwise;
      // the toolkit's current version is what we want for a background sync.
      dangerouslySkipVersionCheck: true,
      arguments: args,
    });
    if (!res.successful) {
      return { skipped: String(res.error ?? "tool failed").slice(0, 200) };
    }
    return { data: rec(res.data) };
  } catch (err) {
    return { skipped: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

async function ingestAll(
  phone: string,
  docs: readonly (ArchiveDocument | null)[],
): Promise<number> {
  let n = 0;
  for (const doc of docs) {
    if (!doc) continue;
    await ingestArchiveDocument(phone, doc);
    n++;
  }
  return n;
}

/**
 * Copy fresh Gmail and Calendar data for one person into their Supermemory
 * archive. Not-connected apps are skipped quietly; upserts keep reruns cheap.
 */
export async function syncTenantArchive(
  phone: string,
  sinceMs: number | undefined,
  nowMs = Date.now(),
): Promise<ArchiveSyncResult> {
  if (!process.env.SUPERMEMORY_API_KEY?.trim()) {
    const skipped = { skipped: "no SUPERMEMORY_API_KEY" };
    return { gmail: skipped, calendar: skipped };
  }

  const gmail = await execute("GMAIL_FETCH_EMAILS", phone, {
    query: gmailQuery(sinceMs, nowMs),
    max_results: 25,
  });
  const gmailResult: AppSyncResult =
    "skipped" in gmail
      ? gmail
      : {
          ingested: await ingestAll(
            phone,
            (Array.isArray(gmail.data.messages) ? gmail.data.messages : []).map(
              emailToDocument,
            ),
          ),
        };

  const calendar = await execute("GOOGLECALENDAR_EVENTS_LIST", phone, {
    calendarId: "primary",
    timeMin: new Date(nowMs).toISOString(),
    timeMax: new Date(nowMs + 14 * 24 * 60 * 60 * 1000).toISOString(),
    singleEvents: true,
    maxResults: 50,
  });
  const calendarResult: AppSyncResult =
    "skipped" in calendar
      ? calendar
      : {
          ingested: await ingestAll(
            phone,
            (Array.isArray(calendar.data.items) ? calendar.data.items : []).map(
              eventToDocument,
            ),
          ),
        };

  return { gmail: gmailResult, calendar: calendarResult };
}
