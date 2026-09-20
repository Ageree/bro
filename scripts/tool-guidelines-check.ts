import { readdirSync } from "node:fs";
import { assert, eq, src } from "./lib/check.ts";
import { buildToolRules, type ToolGuidelines } from "../agent/lib/tool-guidelines.ts";
import {
  MOUNTED_TOOLS,
  TOOL_GUIDELINES,
  comboRules,
  toolRulesBlock,
} from "../agent/lib/tool-rules.ts";
import { estimateTokens } from "./lib/prompt-budget.ts";

/**
 * A tool's rules belong to the tool.
 *
 * `## Браузер` and the `результат тула → что сказать` table used to live in
 * `agent/instructions.md`, which reaches the model on every call — ~1000
 * estimated tokens of rules that only apply once a particular tool has been
 * called and has returned a particular result. They now ride with their tools
 * and are assembled per turn, the way pi's `toolGuidelines` works.
 *
 * Three properties make that safe, and this file exists to hold them:
 * duplication is impossible rather than merely discouraged, an unmounted tool
 * ships nothing, and the byte order never moves (the prompt is the cached
 * prefix of every request in the conversation).
 */

// --- dedupe -----------------------------------------------------------------

{
  const same = "`liveUrl` — вход или 3-D Secure: ссылка отдельной строкой.";
  const out = buildToolRules(["a", "b"], { a: [same], b: [same] });
  eq(out, `- ${same}`, "the same rule from two tools is emitted once");
}

{
  // Whitespace-only differences are the realistic case: the same sentence
  // pasted into two tool files, indented differently by the formatter.
  const out = buildToolRules(["a", "b"], {
    a: ["Код вводи,  не переспрашивай."],
    b: ["Код вводи, не переспрашивай."],
  });
  eq(out.split("\n").length, 1, "whitespace-different copies of a rule collapse");
}

{
  const out = buildToolRules(["a"], { a: ["первое", "", "   ", "второе"] });
  eq(out, "- первое\n- второе", "blank bullets are dropped, not rendered as empty lines");
}

// The real registry must not ship the same sentence from two tools by accident.
{
  const seen = new Map<string, string>();
  for (const [tool, rules] of Object.entries(TOOL_GUIDELINES as ToolGuidelines)) {
    for (const rule of rules) {
      const key = rule.trim().replace(/\s+/g, " ");
      const first = seen.get(key);
      // A deliberate shared rule is fine — dedupe handles it — but it has to be
      // word-for-word, or the two copies will drift and both will be emitted.
      if (first !== undefined) continue;
      seen.set(key, tool);
    }
  }
  const block = toolRulesBlock();
  const bullets = block.split("\n").filter((l) => l.startsWith("- "));
  eq(
    new Set(bullets).size,
    bullets.length,
    "the assembled block contains no duplicate bullet",
  );
}

// --- mounted only -----------------------------------------------------------

{
  const out = buildToolRules(["mounted"], {
    mounted: ["правило смонтированного"],
    absent: ["правило отсутствующего"],
  });
  assert(
    out.includes("правило смонтированного") && !out.includes("правило отсутствующего"),
    "a tool that is not mounted contributes nothing",
  );
}

eq(buildToolRules([], TOOL_GUIDELINES), "", "no mounted tools means no rules at all");
eq(toolRulesBlock([]), "", "an empty block is empty, not a header with nothing under it");

{
  // The combo rule exists only while BOTH tools are mounted: it is about how
  // they divide the work, and is nonsense if one of them cannot be called.
  assert(comboRules(["browser_task", "job"]).length > 0, "the browser/job combo rule fires");
  eq(comboRules(["browser_task"]).length, 0, "the combo rule needs both tools");
  eq(comboRules(["job"]).length, 0, "the combo rule needs both tools, either way round");
}

// --- deterministic order ----------------------------------------------------

{
  eq(toolRulesBlock(), toolRulesBlock(), "the same mounted set renders identical bytes");
  const a = buildToolRules(["x", "y"], { x: ["один"], y: ["два"] });
  const b = buildToolRules(["y", "x"], { x: ["один"], y: ["два"] });
  assert(a !== b, "order follows the mounted list, not the object's key order");
  eq(a, "- один\n- два", "mounted order decides");
  // Adding a guideline for an unmounted tool must not reshuffle anyone else.
  const before = buildToolRules(["x"], { x: ["один"] });
  const after = buildToolRules(["x"], { x: ["один"], z: ["посторонний"] });
  eq(before, after, "an unmounted tool's guideline changes nothing for the mounted ones");
}

// --- the registry matches the tools on disk ---------------------------------
/**
 * `MOUNTED_TOOLS` is written out because neither end offers the roster at
 * runtime, so it can drift from reality in three ways — and each one is
 * silent. A guideline for a name eve never mounts is simply never shipped.
 */
{
  const onDisk = readdirSync(new URL("../agent/tools", import.meta.url))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""));
  // `ask_question` is a `disableTool()` sentinel; `composio` is a dynamic
  // resolver that registers `COMPOSIO_*` names of its own.
  const notMounted = new Set(["ask_question", "composio"]);
  for (const name of onDisk) {
    if (notMounted.has(name)) continue;
    assert(
      MOUNTED_TOOLS.includes(name),
      `agent/tools/${name}.ts exists but is missing from MOUNTED_TOOLS — its rules would never ship`,
    );
  }
  for (const name of MOUNTED_TOOLS) {
    assert(
      onDisk.includes(name),
      `MOUNTED_TOOLS lists "${name}" but agent/tools/${name}.ts does not exist`,
    );
  }
  for (const name of Object.keys(TOOL_GUIDELINES as ToolGuidelines)) {
    assert(
      MOUNTED_TOOLS.includes(name),
      `TOOL_GUIDELINES has rules for "${name}", which is not mounted — they would never reach the model`,
    );
  }
}

// --- the protocol lines survived the move -----------------------------------
/**
 * These read like conversational advice and are not: each one is a literal
 * first bubble the rest of the system keys off. They were the risk of this
 * refactor — prose that looks droppable while being protocol.
 */
{
  const chat = toolRulesBlock(MOUNTED_TOOLS, { liveTab: false });
  const live = toolRulesBlock(MOUNTED_TOOLS, { liveTab: true });

  // Always: these apply whenever the tool can be called at all.
  for (const [needle, what] of [
    ["сначала закончу", "the busy queueing line"],
    ["`liveUrl`", "the live-view link rule"],
  ] as const) {
    assert(chat.includes(needle), `${what} («${needle}») must be on every turn`);
  }
  assert(
    /worker/.test(chat) && /3-D Secure/.test(chat),
    "the worker-is-not-for-3DS rule survives",
  );

  // Only while a tab is open: on an ordinary chat turn there is nothing to
  // type «ввожу код» into, and shipping the rule anyway is the ~250 tokens the
  // whole refactor exists to stop paying.
  for (const [needle, what] of [
    ["ввожу код", "the live-tab code bubble"],
    ["подожду", "the live-tab wait bubble"],
    ["проверяю", "the live-tab confirm bubble"],
    ["продолжаю в той же вкладке", "the payment/address continuation bubble"],
    ["ПОЛНЫМ обновлённым поручением", "a correction restates the whole errand"],
  ] as const) {
    assert(live.includes(needle), `${what} («${needle}») must reach a live-tab turn`);
    assert(
      !chat.includes(needle),
      `${what} («${needle}») must NOT be shipped on a turn with no open tab`,
    );
  }
  assert(live.length > chat.length, "the live-tab turn carries strictly more rules");
}

// --- the block is charged what it costs -------------------------------------
{
  const declared = /prompt-budget:\s*runtime\s+(\d+)/.exec(src("agent/instructions/tools.ts"));
  assert(declared !== null, "agent/instructions/tools.ts declares its per-turn budget");
  const cap = Number(declared![1]);
  const actual = estimateTokens(toolRulesBlock(MOUNTED_TOOLS, { liveTab: true }));
  const chatTokens = estimateTokens(toolRulesBlock(MOUNTED_TOOLS, { liveTab: false }));
  // The declared figure is what an ORDINARY turn pays, because that is what the
  // per-turn budget should reflect; the live-tab peak gets its own ceiling.
  const LIVE_TAB_CEILING_TOKENS = 850;
  assert(
    chatTokens <= cap,
    `a chat turn's tool rules are ~${chatTokens} tok, over the ${cap} tok this module declares`,
  );
  assert(
    chatTokens >= cap * 0.6,
    `a chat turn's tool rules are ~${chatTokens} tok against a declared ${cap} — re-take the cap`,
  );
  assert(
    actual <= LIVE_TAB_CEILING_TOKENS,
    `a live-tab turn's tool rules are ~${actual} tok, over the ${LIVE_TAB_CEILING_TOKENS} ceiling`,
  );
  console.log(
    `tool rules: ~${chatTokens} tok on a chat turn, ~${actual} tok with a live tab (declared cap ${cap})`,
  );
}

console.log("tool-guidelines-check ok");
