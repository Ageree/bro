/**
 * What one turn actually costs in prompt, measured from source.
 *
 * Before this existed, nobody could say how big Bro's system prompt was.
 * `instructions:check` guarded a byte ceiling on ONE file and expressed it as
 * "baseline +10%", so the only thing the repo could measure was permission to
 * grow. Meanwhile the real per-turn prompt is four surfaces, not one:
 *
 *   1. ALWAYS-ON   — `agent/instructions.md` + `agent/instructions/*`, sent
 *                    outside history on every single model call.
 *   2. TOOLS       — every tool's description + input schema, also every call.
 *   3. SKILL INDEX — each skill's `description` frontmatter, also every call.
 *   4. ON-DEMAND   — a skill's body, only once the model calls `load_skill`.
 *
 * Only (1)-(3) are the per-turn tax. (4) is what eve's docs call progressive
 * disclosure, and moving a situational procedure from (1) to (4) is the whole
 * point of the trim: "Keep instructions short and stable. Long or situational
 * procedures belong in skills" (eve docs/instructions.mdx).
 *
 * Token counts here are ESTIMATES, deliberately tokenizer-free: pulling a real
 * BPE table in would make an offline check depend on a model download. The
 * estimator is calibrated for the mixed Russian/English this prompt actually
 * is — Cyrillic costs roughly twice what Latin does on the same character
 * count, which is why a 15k-character file weighs ~5.5k tokens rather than the
 * ~3.8k a naive chars/4 rule would claim. Ratios and deltas are what this
 * module is for; a number here is never a billing figure.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

/** Average characters per token, by script. Cyrillic tokenizes far worse than
 *  Latin on every BPE vocabulary this project could run on, so a single
 *  chars/4 rule understates a Russian prompt by ~40%. */
const CHARS_PER_TOKEN_CYRILLIC = 2.0;
const CHARS_PER_TOKEN_LATIN = 3.8;

export function estimateTokens(text: string): number {
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const rest = text.length - cyrillic;
  return Math.round(cyrillic / CHARS_PER_TOKEN_CYRILLIC + rest / CHARS_PER_TOKEN_LATIN);
}

export type Surface = "always-on" | "tools" | "skill-index" | "on-demand";

export type Entry = {
  surface: Surface;
  /** Repo-relative path, or `<path>#<section>` for a slice of a file. */
  label: string;
  chars: number;
  tokens: number;
};

export type Budget = {
  entries: Entry[];
  /** Everything the model pays for on every single call. */
  perTurnTokens: number;
  /** Skill bodies, paid only when `load_skill` pulls one in. */
  onDemandTokens: number;
};

function entry(surface: Surface, label: string, text: string): Entry {
  return { surface, label, chars: text.length, tokens: estimateTokens(text) };
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function listDir(rel: string): string[] {
  try {
    return readdirSync(join(ROOT, rel)).sort();
  } catch {
    return [];
  }
}

function isDir(rel: string): boolean {
  try {
    return statSync(join(ROOT, rel)).isDirectory();
  } catch {
    return false;
  }
}

/** Splits a markdown prompt into its `## ` sections so the report can show
 *  which part of the file is expensive, not just that the file is. */
export function sections(markdown: string): { title: string; text: string }[] {
  const parts = markdown.split(/\n(?=## )/);
  return parts.map((text) => {
    const first = text.split("\n", 1)[0] ?? "";
    return { title: first.replace(/^#+\s*/, "").trim() || "(preamble)", text };
  });
}

/**
 * The root prompt: `agent/instructions.md` plus every entry of
 * `agent/instructions/`. Static `.md` entries are counted verbatim. A `.ts`
 * entry is a `defineDynamic` resolver whose output varies per turn, so its
 * literal strings are counted as an UPPER bound and flagged — a turn pays for
 * whichever subset fired, never for all of them at once.
 */
export function rootInstructions(): Entry[] {
  const out: Entry[] = [];
  const root = read("agent/instructions.md");
  for (const s of sections(root)) {
    out.push(entry("always-on", `agent/instructions.md#${s.title}`, s.text));
  }
  for (const name of listDir("agent/instructions")) {
    const rel = `agent/instructions/${name}`;
    if (name.endsWith(".md")) {
      out.push(entry("always-on", rel, read(rel)));
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    const source = read(rel);
    // A resolver whose branches are ALTERNATIVES (exactly one reaches any
    // given turn, like one channel's formatting rules) would be counted at
    // twice its true cost by summing them. Such a module says so with the
    // marker below, and is charged its largest branch instead. Everything
    // else composes — jobs.ts really can emit several blocks at once — so the
    // default stays the sum, which is the safe direction for a budget.
    const literals = dynamicLiteralList(source);
    // A resolver that BUILDS its prompt at runtime (the person profile is
    // assembled from Convex rows, not written out here) has no literals to
    // count, and would otherwise read as free. It is not free — it is on every
    // call. Such a module declares the cap it enforces on itself, and is
    // charged that cap. Declaring a cap and then exceeding it is the module's
    // own test to fail, not this one's.
    const runtime = RUNTIME_MARKER.exec(source);
    if (runtime) {
      const tokens = Number(runtime[1]);
      out.push({
        surface: "always-on",
        label: `${rel} (dynamic, declared cap)`,
        chars: 0,
        tokens,
      });
      continue;
    }
    if (EXCLUSIVE_MARKER.test(source)) {
      const largest = literals.reduce((a, b) => (b.length > a.length ? b : a), "");
      out.push(entry("always-on", `${rel} (dynamic, one branch of ${literals.length})`, largest));
      continue;
    }
    out.push(entry("always-on", `${rel} (max, dynamic)`, literals.join("\n")));
  }
  return out;
}

/** Opt-in marker a dynamic instruction module writes when its prompt literals
 *  are alternatives rather than parts — see `rootInstructions`. */
export const EXCLUSIVE_MARKER = /prompt-budget:\s*exclusive/;

/** Opt-in marker a dynamic instruction module writes when its prompt is built
 *  at runtime and it enforces its own token cap — see `rootInstructions`. */
export const RUNTIME_MARKER = /prompt-budget:\s*runtime\s+(\d+)/;

/** Every string literal long enough to be prompt text rather than a key or a
 *  field name. Crude on purpose: it is an upper bound, and a bound that drifts
 *  high is the safe direction for a budget. */
export function dynamicLiterals(source: string): string {
  return dynamicLiteralList(source).join("\n");
}

export function dynamicLiteralList(source: string): string[] {
  const found: string[] = [];
  const re = /(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  for (const m of source.matchAll(re)) {
    const raw = m[1] ?? "";
    const body = raw.slice(1, -1);
    // Prompt sentences have spaces; identifiers, slugs and paths do not.
    if (body.length >= 40 && body.includes(" ")) found.push(body);
  }
  return found;
}

/**
 * Tool descriptions and input schemas. Both reach the model on every call.
 *
 * EVERY description in a file counts, not just the first. `agent/tools/composio.ts`
 * registers seven tools from one `defineDynamic` resolver
 * (COMPOSIO_SEARCH_TOOLS, …_MANAGE_CONNECTIONS, …_REMOTE_BASH_TOOL and the
 * rest), and a reader who counted one of them would conclude that Composio
 * costs 28 tokens a turn when it costs several hundred. A tool surface is the
 * sum of what the model is shown, however many `defineTool` calls produced it.
 */
export function toolSurfaces(dir = "agent/tools"): Entry[] {
  const out: Entry[] = [];
  for (const name of listDir(dir)) {
    if (!name.endsWith(".ts")) continue;
    const rel = `${dir}/${name}`;
    const source = read(rel);
    const str = String.raw`(?:\`(?:[^\`\\]|\\.)*\`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;
    const descRe = new RegExp(`description:\\s*(${str}(?:\\s*\\+\\s*${str})*)`, "g");
    const parts: string[] = [];
    for (const m of source.matchAll(descRe)) parts.push(m[1] ?? "");
    // Zod schemas and raw JSON-schema object literals both become tool
    // parameters in the prompt, so both are charged.
    for (const m of source.matchAll(/inputSchema:\s*z\.object\(\{[\s\S]*?\n\s*\}\)/g)) {
      parts.push(m[0]);
    }
    for (const m of source.matchAll(/inputSchema:\s*\{[\s\S]*?\n(\s*)\},?\n/g)) {
      parts.push(m[0]);
    }
    const text = parts.filter(Boolean).join("\n");
    if (!text) continue;
    out.push(entry("tools", rel, text));
  }
  return out;
}

/**
 * Skills, split the way eve actually charges for them: the `description`
 * frontmatter is advertised on every call, the body only enters context when
 * `load_skill` pulls it.
 */
export function skillSurfaces(dir = "agent/skills"): Entry[] {
  const out: Entry[] = [];
  for (const name of listDir(dir)) {
    const base = `${dir}/${name}`;
    const rel = isDir(base) ? `${base}/SKILL.md` : base;
    if (!rel.endsWith(".md")) continue;
    let text: string;
    try {
      text = read(rel);
    } catch {
      continue;
    }
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    const description = fm?.[1]?.match(/description:\s*(.*)/)?.[1] ?? "";
    out.push(entry("skill-index", `${rel} (description)`, description));
    const body = fm ? text.slice(fm[0].length) : text;
    out.push(entry("on-demand", `${rel} (body)`, body));
    // References are siblings a loaded skill may read; never automatic.
    if (isDir(base)) {
      for (const refName of listDir(`${base}/references`)) {
        if (!refName.endsWith(".md")) continue;
        const refRel = `${base}/references/${refName}`;
        out.push(entry("on-demand", refRel, read(refRel)));
      }
    }
  }
  return out;
}

export function measure(): Budget {
  const entries = [...rootInstructions(), ...toolSurfaces(), ...skillSurfaces()];
  const sum = (surface: Surface) =>
    entries.filter((e) => e.surface === surface).reduce((n, e) => n + e.tokens, 0);
  return {
    entries,
    perTurnTokens: sum("always-on") + sum("tools") + sum("skill-index"),
    onDemandTokens: sum("on-demand"),
  };
}

export function formatBudget(budget: Budget): string {
  const lines: string[] = [];
  const order: Surface[] = ["always-on", "tools", "skill-index", "on-demand"];
  const titles: Record<Surface, string> = {
    "always-on": "ALWAYS-ON — every model call",
    tools: "TOOLS — descriptions + schemas, every model call",
    "skill-index": "SKILL INDEX — descriptions only, every model call",
    "on-demand": "ON-DEMAND — skill bodies, only after load_skill",
  };
  for (const surface of order) {
    const rows = budget.entries
      .filter((e) => e.surface === surface)
      .sort((a, b) => b.tokens - a.tokens);
    if (rows.length === 0) continue;
    const total = rows.reduce((n, r) => n + r.tokens, 0);
    lines.push(`\n${titles[surface]}  —  ~${total} tok`);
    for (const r of rows) {
      if (r.tokens === 0) continue;
      lines.push(`  ${String(r.tokens).padStart(6)} tok  ${String(r.chars).padStart(6)} ch  ${r.label}`);
    }
  }
  lines.push("");
  lines.push(`PER-TURN TAX   ~${budget.perTurnTokens} tok`);
  lines.push(`ON-DEMAND      ~${budget.onDemandTokens} tok (not charged unless loaded)`);
  return lines.join("\n");
}
