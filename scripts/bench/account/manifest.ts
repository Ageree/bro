import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * What `fixtures seed` put into which account, so `fixtures clean` removes
 * exactly that and nothing the tester had before. It lives next to the
 * sign-in cookie, outside any repository: it names the tester's mailbox.
 */

export const defaultManifestFile = join(
  homedir(),
  ".bro-bench",
  "fixtures.json"
);

const manifestSchema = z.object({
  /** Letters, events and files created, one per fixture item. */
  items: z.array(
    z.object({
      /** The Composio connected account it was created through. */
      account: z.string().min(1),
      createdAt: z.string(),
      /** Gmail message, Calendar event or Drive file id. */
      id: z.string().min(1),
      /** `<set>/<item>`: the catalog's name for it. */
      key: z.string().min(1),
      kind: z.enum(["document", "event", "letter"]),
      summary: z.string(),
      threadId: z.string().optional(),
    })
  ),
  labels: z.array(
    z.object({
      account: z.string().min(1),
      /** Only a label the seed created is removed by a full clean. */
      created: z.boolean(),
      id: z.string().min(1),
    })
  ),
  sets: z.array(
    z.object({
      account: z.string().min(1),
      cases: z.array(z.string()),
      /** False while a seed is still inserting it, or was cut short. */
      complete: z.boolean(),
      expect: z.array(z.string()),
      mailbox: z.string(),
      seededAt: z.string(),
      set: z.string().min(1),
    })
  ),
  version: z.literal(1),
});

export type FixtureManifest = z.infer<typeof manifestSchema>;

export async function readManifest(path: string): Promise<FixtureManifest> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { items: [], labels: [], sets: [], version: 1 };
  }
  return manifestSchema.parse(JSON.parse(text));
}

/** Written whole after every change, so an interrupted seed is still cleanable. */
export async function writeManifest(path: string, manifest: FixtureManifest) {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const draft = `${path}.tmp`;
  await writeFile(
    draft,
    `${JSON.stringify(manifestSchema.parse(manifest), null, 2)}\n`,
    { mode: 0o600 }
  );
  await chmod(draft, 0o600);
  await rename(draft, path);
}

export const setOf = (key: string) => key.split("/")[0] ?? key;
