import { buildToolRules, type ToolGuidelines } from "./tool-guidelines.ts";

/**
 * The bullets each tool contributes to the system prompt.
 *
 * WHY they live here and not beside their `defineTool`. Every file under
 * `agent/tools/` imports the runtime it drives — Convex, eve, the browser
 * client — so exporting a guideline from one of them means the dynamic
 * instruction resolver, and every offline check that wants to assemble the
 * real block, has to drag that whole runtime in. `tool-guidelines-check`
 * could not even load. This module is pure data with no imports, which is what
 * lets the check assert the text the model will actually see.
 *
 * That is also how pi does it: its `toolGuidelines` is a
 * `Record<string, string[]>` handed to the prompt builder, not something a
 * tool definition carries. The property that matters is not which file the
 * string sits in — it is that a tool which is not mounted contributes nothing,
 * that duplicates collapse, and that the order never moves. All three are
 * enforced in `agent/lib/tool-guidelines.ts` and asserted by the check.
 *
 * Keyed by the name eve mounts the tool under, so a renamed or deleted tool
 * fails the check instead of silently shipping rules for something that is not
 * there any more.
 */

export const BROWSER_TASK_GUIDELINES: readonly string[] = [
  "Никогда не говори «не входи» и не проси пароль: вход проходит сам.",
  "`worker` — второй браузер под одноэкранную задачу; никогда для 3-D Secure, кода или капчи из вкладки `browser_task`: туда одна дверь — её `liveUrl`. Он отдаёт `needs`/`liveViewUrl` и человеку не пишет.",
  "`[background wakeup]`: `done` — отвечай из результата в промпте; `need` — отправь данную строку как есть (`email_code` → сначала `otp_lookup`); `failed`/`giveup` — одна строка и предложи повторить.",
  "`completed` со списком — «нашёл N вариантов: цена — название, …», без ссылок; `completed` с заказом или записью — «готово», что сделано, номер, сумма, когда, 1–2 пузыря.",
  "Ещё идёт или `polled` — свежая короткая строка о том, что работа не встала, а не «напиши позже»; `landed:false` — страница открылась, экран ещё грузится.",
  '`status:"busy"` → ровно «сначала закончу X, потом сделаю Y» — второе встанет в очередь само.',
  // Also exported, word for word, by `profile_setup` — both tools hand back a
  // `liveUrl` and both must say the same thing about it. `buildToolRules`
  // dedupes, so the model sees it once however many tools claim it.
  "`liveUrl` — вход или 3-D Secure: ссылка отдельной строкой и словами, что с ней делать.",
];

export const PROFILE_SETUP_GUIDELINES: readonly string[] = [
  "`liveUrl` — вход или 3-D Secure: ссылка отдельной строкой и словами, что с ней делать.",
];

/**
 * The half of `browser_task`'s rules that only mean anything while a tab of
 * its own is open.
 *
 * Splitting them is where the tool-guidelines refactor actually pays. Moving
 * rules out of `agent/instructions.md` bought structure — one source per rule,
 * dedupe, deletion-safety — but it bought no budget, because every tool Bro has
 * is mounted on every turn, so "mounted only" never filters anything. pi's
 * saving comes from `selectedTools` genuinely varying; ours has to come from
 * the turn instead.
 *
 * These three are dead weight on an ordinary chat turn: there is no tab to type
 * «ввожу код» into, nothing to continue «в той же вкладке», and no closed
 * errand to restate in full. `agent/instructions/tools.ts` ships them only when
 * a session is live or a start is in flight — the same condition
 * `agent/instructions/jobs.ts` already computes for its inject steer, read from
 * the same TTL-cached tenant row, so the extra precision costs no round trip.
 */
export const BROWSER_TASK_LIVE_TAB_GUIDELINES: readonly string[] = [
  "Живая вкладка ждёт и пришёл код / «подожди» / уточнение (адрес, размер, ПВЗ) / «подтвердил», «готово», «вошёл» → первая строка ровно «ввожу код» / «подожду» / «ввожу» / «проверяю», следом `browser_task` с его точной строкой. Код вводи, не переспрашивай. То же для любой другой детали к тому же поручению («сделай эконом», «поменяй время») — это про любой сайт, не только Яндекс. Смолток, «ну как там?» и новое несвязанное поручение туда не клади.",
  "После «НУЖНО: payment/address/info» прислали недостающее → первая строка ровно «продолжаю в той же вкладке», и `browser_task` с продолжением, без `reset:true`.",
  "Поручение закрыто, человек поправляет («не тот размер») → новый `browser_task` с ПОЛНЫМ обновлённым поручением, не с одной правкой.",
];

/**
 * The tools eve mounts for a 1:1 turn — one per file under `agent/tools/`,
 * named by its slug.
 *
 * It is written out rather than discovered because neither end offers the
 * roster at runtime: `DynamicResolveContext` carries session, channel and
 * messages only, and the deployed agent is a bundle with no `agent/tools/`
 * directory to read. So the list is asserted instead — `guidelines:check`
 * fails if a name here has no tool file, if a tool file is missing from here,
 * or if a guideline is written for a tool that is not on this list. Delete a
 * tool and its rules stop being shipped, which is the property the old central
 * table could not have.
 *
 * Two files are not mounted tools and are not listed: `ask_question.ts` is a
 * `disableTool()` sentinel, and `composio.ts` is a dynamic resolver that
 * registers `COMPOSIO_*` names of its own.
 */
export const MOUNTED_TOOLS: readonly string[] = [
  "bro_mail",
  "browser_task",
  "cancel_wakeup",
  "files_delete",
  "files_get",
  "files_list",
  "files_save",
  "imessage_react",
  "job",
  "list_orders",
  "otp_lookup",
  "profile_setup",
  "sandbox_run",
  "schedule_wakeup",
  "send_photo",
  "telegram_react",
  "vault_setup",
  "watch_app",
  "web_fetch",
  "web_search",
];

/** Every tool that brings rules, keyed by the name eve mounts it under. */
export const TOOL_GUIDELINES: ToolGuidelines = {
  browser_task: BROWSER_TASK_GUIDELINES,
  profile_setup: PROFILE_SETUP_GUIDELINES,
  // `vault_setup` deliberately brings none. Its one rule — «карту в чат не
  // проси, пришли ссылку» — is already delivered at runtime, in the tool's own
  // result, so stating it again here would put it on every turn to save
  // nothing. A tool earns a guideline only when the model has to know the rule
  // BEFORE it calls the tool.
};

/**
 * Rules that belong to a PAIR of tools rather than to either one of them.
 *
 * `browser_task` cannot state «don't reach for `job` here» on its own without
 * teaching the model about a tool that may not be mounted, and `job` has no
 * business describing the browser. pi keeps the same kind of rule inside
 * `buildRules` (its bash/grep/find combination); here it is computed at the
 * mount site, from the mounted set, and passed in as `extra`.
 */
export function comboRules(mounted: readonly string[]): readonly string[] {
  const has = (name: string): boolean => mounted.includes(name);
  const rules: string[] = [];
  if (has("browser_task") && has("job")) {
    rules.push(
      "`job` рядом с браузером не нужен, `browser_task` доводит сам; `job` — это ожидание человека или письма ПОСЛЕ шага в браузере.",
    );
  }
  return rules;
}

/**
 * The assembled block, exported so the check can assert the real text.
 *
 * `liveTab` adds the rules that only mean something while `browser_task` is
 * holding a tab open. On an ordinary chat turn there is nothing to type «ввожу
 * код» into, so shipping them would be ~250 tokens of instructions about a
 * situation that does not exist.
 */
export function toolRulesBlock(
  mounted: readonly string[] = MOUNTED_TOOLS,
  opts: { liveTab?: boolean } = {},
): string {
  const guidelines: ToolGuidelines = opts.liveTab
    ? {
        ...TOOL_GUIDELINES,
        browser_task: [
          ...(TOOL_GUIDELINES.browser_task ?? []),
          ...BROWSER_TASK_LIVE_TAB_GUIDELINES,
        ],
      }
    : TOOL_GUIDELINES;
  const rules = buildToolRules(mounted, guidelines, comboRules(mounted));
  if (!rules) return "";
  return `Инструменты этого хода — что говорить вокруг них:\n\n${rules}`;
}
