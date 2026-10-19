import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { registerApplicationModuleResolution } from "../lib/module-resolution.ts";

/**
 * How long a voice note's transcription takes (19.10): runs the product's
 * own `transcribeAudio` on each `--voice` file `--runs` times, one after
 * another, and prints a JSON line per call with its milliseconds. A
 * Telegram turn waits on it before eve gets the message. Needs the
 * application's model settings: MODEL_PROVIDER=routerai with
 * ROUTERAI_API_KEY, BETTER_AUTH_URL and DATABASE_URL (no database opens).
 *
 *   node --experimental-strip-types scripts/bench/transcription.ts \
 *     --runs 5 --voice note.ogg
 */

const { values: flags } = parseArgs({
  options: {
    runs: { default: "5", type: "string" },
    voice: { multiple: true, type: "string" },
  },
});

registerApplicationModuleResolution();
const { transcribeAudio } =
  await import("@agent/lib/inbound-media/transcription");

for (const path of flags.voice ?? []) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- one file at a time
  const bytes = new Uint8Array(await readFile(path));
  for (let run = 0; run < Number(flags.runs); run += 1) {
    const started = performance.now();
    // oxlint-disable-next-line eslint/no-await-in-loop -- calls one after another, as a chat sends them
    const result = await transcribeAudio({ bytes, filename: basename(path) });
    console.log(
      JSON.stringify({
        file: basename(path),
        kind: result.kind,
        ms: Math.round(performance.now() - started),
        run,
      })
    );
  }
}
