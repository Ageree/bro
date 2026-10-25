import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import {
  mergeSiteOperations,
  type SiteOperation,
  siteOperationSchema,
} from "../../agent/lib/browser-vm/site-ops/operation.ts";

/**
 * The operations browser runs found behind their reports, for a person to
 * review before they become everybody's (`knownSiteOperations`).
 *
 *   node --experimental-strip-types scripts/site-ops/review.ts <run.json or folder>...
 *
 * Reads worker run records (a folder is searched for `*.json`: the
 * worker's `runs/`, the stand's run folders), keeps each record's
 * `siteTraffic.operations` that the schema takes (a refused one is named
 * with its reason), makes finds that differ only in a part of the page's
 * path one with a placeholder there (`mergeSiteOperations`), and prints
 * them as JSON with how many runs found each. What the request log of each
 * run looked like is printed beside: how many of the site's requests, of
 * which kinds. Nothing is written: a reviewed operation is copied into
 * `agent/lib/browser-vm/site-ops/known.ts` by hand, with its `about`.
 */
const recordSchema = z.object({
  id: z.string(),
  siteTraffic: z
    .object({
      operations: z.array(z.json()).default([]),
      requests: z
        .array(z.object({ type: z.string(), url: z.string() }))
        .default([]),
    })
    .nullish(),
});

function records(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  // Entries as they are: a browser profile in a stand's folder has dangling links.
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const inside = join(path, entry.name);
    if (entry.isDirectory()) return records(inside);
    return entry.isFile() && entry.name.endsWith(".json") ? [inside] : [];
  });
}

const found: { operation: SiteOperation; runs: number }[] = [];
for (const file of process.argv.slice(2).flatMap(records)) {
  const parsed = recordSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success || !parsed.data.siteTraffic) continue;
  const { operations, requests } = parsed.data.siteTraffic;
  const kinds = Object.entries(
    Object.groupBy(requests, (request) => request.type)
  ).map(([kind, list]) => `${kind} ${String(list?.length ?? 0)}`);
  console.error(
    `${file}: ${String(requests.length)} requests (${kinds.join(", ")})`
  );
  for (const record of operations) {
    const operation = siteOperationSchema.safeParse(record);
    if (!operation.success) {
      console.error(
        `  refused: ${operation.error.issues.map((issue) => issue.message).join("; ")}`
      );
      continue;
    }
    const merged = found.findIndex(
      (kept) =>
        kept.operation.name === operation.data.name ||
        mergeSiteOperations(kept.operation, operation.data) !== undefined
    );
    const kept = found[merged];
    if (kept === undefined) {
      found.push({ operation: operation.data, runs: 1 });
    } else {
      kept.operation =
        mergeSiteOperations(kept.operation, operation.data) ?? operation.data;
      kept.runs += 1;
    }
  }
}
console.log(JSON.stringify(found, null, 2));
