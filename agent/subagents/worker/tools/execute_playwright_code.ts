import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { scrubSecrets } from "../../../../convex/lib/secretScrub.ts";
import { checkPlaywrightCode } from "../lib/code-guard";
import { kernel } from "../lib/kernel";
import { requireOwnedBrowser } from "../lib/scope";

// Kernel's Playwright execution endpoint is what bounds a single program; 25s
// is the ceiling this tool hands it and nothing in-session can raise it, so the
// model has to size every wait inside one call against this number. It is a
// fact about the platform, not a budget on how hard the worker may try.
const playwrightTimeoutSeconds = 25;
const modelResultCharacterLimit = 12_000;
const modelLogCharacterLimit = 2_000;

const inputSchema = z.object({
  code: z.string().min(1),
  session_id: z.string().min(1),
});

const browserResultSchema = z.json();
const outputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  result: browserResultSchema.optional(),
  stderr: z.string().optional(),
  stdout: z.string().optional(),
  warning: z.string().optional(),
});

export default defineTool({
  description:
    'Execute one bounded Playwright/TypeScript program against an existing browser session with a 25-second ceiling. Prefer one program per page state that inspects, performs all related safe actions, verifies the outcome, and returns one compact object. Use "domcontentloaded" or a precise locator wait whose deadline fits the 25-second ceiling and matches how slow the site really is, and never wait for "networkidle" or use blind multi-second sleeps. Does not create or delete browsers. After fill_from_vault ran in this session, code that reads back field values, cookies, or storage is refused.',
  inputSchema,
  outputSchema,
  async execute(input, ctx) {
    await requireOwnedBrowser(ctx, input.session_id);
    const verdict = checkPlaywrightCode(input.code, ctx.session.id);
    if (verdict.blocked) {
      throw new Error(verdict.reason);
    }
    const result = outputSchema.parse(
      await kernel().browsers.playwright.execute(
        input.session_id,
        {
          code: input.code,
          timeout_sec: playwrightTimeoutSeconds,
        },
        { signal: ctx.abortSignal },
      ),
    );
    if (verdict.warning) result.warning = verdict.warning;
    return result;
  },
  toModelOutput(output) {
    const value: z.output<typeof outputSchema> = { success: output.success };
    if (output.error) {
      value.error = truncate(scrubSecrets(output.error), modelLogCharacterLimit);
    }
    if (output.result !== undefined) {
      value.result = boundedResult(output.result);
    }
    if (output.stderr) {
      value.stderr = truncate(scrubSecrets(output.stderr), modelLogCharacterLimit);
    }
    if (output.stdout) {
      value.stdout = truncate(scrubSecrets(output.stdout), modelLogCharacterLimit);
    }
    if (output.warning) {
      value.warning = output.warning;
    }
    return toolOutput.json(value);
  },
});

function boundedResult(
  value: z.infer<typeof browserResultSchema>,
): z.infer<typeof browserResultSchema> {
  const scrubbed = scrubDeep(value) as z.infer<typeof browserResultSchema>;
  const serialized = JSON.stringify(scrubbed);
  if (serialized.length <= modelResultCharacterLimit) {
    return scrubbed;
  }
  return {
    characterCount: serialized.length,
    preview: serialized.slice(0, modelResultCharacterLimit),
    truncated: true,
  };
}

// Only string leaves can carry a card/CVV/password read back from the page;
// numbers and booleans pass through untouched.
function scrubDeep(value: unknown): unknown {
  if (typeof value === "string") return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = scrubDeep(inner);
    }
    return out;
  }
  return value;
}

function truncate(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${String(value.length - limit)} characters]`;
}
