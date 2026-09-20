import { assert, eq, src } from "./lib/check.ts";
import {
  INSTINCT_FORBIDDEN_PREFIX,
  INSTINCT_FORBIDDEN_TOOLS,
  instinctRefusalHint,
  instinctToolAllowed,
  instinctWakePrompt,
} from "../convex/lib/instinctPolicy.ts";
import { instinctBlocked, isInstinctTurn } from "../agent/lib/instinct-guard.ts";
import {
  watcherPayDecision,
  watcherPayloadOf,
} from "../agent/lib/browser-task-policy.ts";
import { watcherWakeupPrompt } from "../convex/lib/purchasePolicy.ts";
import { payHostConfirmHint } from "../agent/lib/browser-pay.ts";

/**
 * What Bro may do when nobody is in the chat.
 *
 * Three of this repo's paths run with no human at the other end: the watcher
 * wakeup, the instinct scan, and the payment continuation that resumes an
 * errand on its own. Each one used to be governed by a Russian sentence in a
 * prompt — read once, by the weakest model in the system, with nobody to
 * notice it read it wrong. This file holds the code that replaced those
 * sentences.
 */

// --- the watcher: «следи» is not «следи и купи» ------------------------------

const watcher = (payload: string) => ({
  origin: "wakeup",
  wakeupKind: "watcher",
  wakeupPayload: payload,
});

{
  eq(
    watcherPayloadOf(watcher("купи когда подешевеет до 3000")),
    "купи когда подешевеет до 3000",
    "a watcher turn carries its own payload",
  );
  // The model must not be able to claim it is a watcher: the payload is read
  // from the turn's auth attributes, which only the wakeup route writes.
  eq(
    watcherPayloadOf({ wakeupKind: "watcher", wakeupPayload: "купи что угодно" }),
    undefined,
    "an attribute set without origin=wakeup is not a watcher turn",
  );
  eq(
    watcherPayloadOf({ origin: "human", wakeupPayload: "купи что угодно" }),
    undefined,
    "a human turn is never a watcher turn",
  );
}

{
  const notify = watcherPayDecision(watcher("следи за ценой на кроссовки"));
  assert(!notify.allow, "a notify-only watcher may not pay");
  assert(
    !notify.allow && notify.hint.includes("наблюдение"),
    "and says why, in words the model can pass on",
  );

  const buy = watcherPayDecision(watcher("купи когда подешевеет до 3000"));
  assert(buy.allow, "a buy-when watcher may pay");
  eq(buy.allow && buy.maxRub, 3000, "with the ceiling the person actually typed");
}

{
  // The errand may be stricter than the person was, never looser.
  const over = watcherPayDecision(watcher("купи когда подешевеет до 3000"), 9000);
  eq(over.allow && over.maxRub, 3000, "a model asking for more than the person allowed is clamped");
  const under = watcherPayDecision(watcher("купи когда подешевеет до 3000"), 1000);
  eq(under.allow && under.maxRub, 1000, "a model asking for less is left alone");
}

{
  // Every other turn passes through untouched — this gates unattended
  // spending, not a person asking Bro to buy something.
  const human = watcherPayDecision({ origin: "human" }, 5000);
  eq(human.allow && human.maxRub, 5000, "a human turn keeps the maxRub it was given");
  assert(watcherPayDecision(undefined).allow, "a turn with no attributes at all is allowed");
  assert(watcherPayDecision(watcher("купи когда появится в наличии")).allow,
    "a buy-when watcher with no ceiling still buys");
}

{
  // The prompt states the resolved number, so the model stops at the right
  // price on the page rather than after the charge.
  const prompt = watcherWakeupPrompt("купи когда подешевеет до 3000");
  assert(prompt.includes("3000 ₽"), "the buy prompt names the ceiling as a number");
  const watch = watcherWakeupPrompt("следи за ценой на кроссовки");
  assert(watch.includes("не покупай"), "the notify-only prompt says not to buy");
  assert(!watch.includes("`pay`"), "and never offers `pay` as a next step");
}

{
  const tool = src("agent/tools/browser_task.ts");
  assert(
    tool.includes("watcherPayDecision(turnAttrs, pay?.maxRub)"),
    "browser_task resolves the watcher decision from the turn, not from an argument",
  );
  eq(
    (tool.match(/status: "refused", hint: watcherPay\.hint/g) ?? []).length,
    2,
    "and refuses on both card-binding paths — the fresh start and the continuation",
  );
  assert(
    !/\.\.\.\(pay\?\.maxRub !== undefined/.test(tool),
    "no path still takes maxRub straight from the model's argument",
  );
}

// --- the instinct turn: it may look and speak, and nothing else --------------

const instinct = { origin: "wakeup", wakeupKind: "instinct" };

{
  assert(isInstinctTurn(instinct), "an instinct wakeup is an instinct turn");
  assert(!isInstinctTurn({ origin: "wakeup", wakeupKind: "watcher" }), "a watcher is not");
  assert(!isInstinctTurn({ origin: "human" }), "a human turn is not");
  assert(!isInstinctTurn(undefined), "and neither is a turn with no attributes");
}

{
  for (const tool of INSTINCT_FORBIDDEN_TOOLS) {
    assert(!instinctToolAllowed(tool), `${tool} is forbidden on an unprompted turn`);
    const blocked = instinctBlocked(instinct, tool);
    assert(blocked !== null, `${tool} is actually blocked, not merely listed`);
    assert(blocked!.hint.includes(tool), "and the refusal names the tool");
    eq(instinctBlocked({ origin: "human" }, tool), null, `${tool} is fine on a human turn`);
  }
  assert(
    !instinctToolAllowed(`${INSTINCT_FORBIDDEN_PREFIX}GMAIL_SEND_EMAIL`),
    "the whole COMPOSIO_* family is forbidden: the prompt came out of those apps",
  );
  // Reads that go nowhere but this chat stay available — the turn is allowed
  // to be useful, it is only not allowed to act.
  for (const ok of ["list_orders", "files_list", "files_get", "web_search", "imessage_react"]) {
    assert(instinctToolAllowed(ok), `${ok} stays available on an instinct turn`);
  }
}

{
  // A refusal has to end the turn, not start a retry loop: the model is told
  // what to do instead.
  const hint = instinctRefusalHint("browser_task");
  assert(hint.includes("[SILENT]"), "the refusal offers silence as an ending");
  assert(/напиши одну короткую строку/.test(hint), "and one line to the person as the other");
  assert(
    instinctWakePrompt([{ kind: "mail_actionable", summary: "письмо", sourceId: "m:1" }])
      .includes("ничего не делай и не запускай"),
    "the instinct prompt says the same thing the guard enforces",
  );
}

{
  // Every forbidden tool must actually call the guard. A name on the list with
  // no call site is the exact failure this whole file exists to stop.
  for (const tool of INSTINCT_FORBIDDEN_TOOLS) {
    const file = src(`agent/tools/${tool}.ts`);
    assert(
      new RegExp(`instinctBlocked\\((?:turnAttrs|turnAttributes\\(ctx\\)), "${tool}"\\)`).test(file),
      `agent/tools/${tool}.ts is on the forbidden list but never asks the guard`,
    );
  }
  assert(
    src("agent/tools/composio.ts").includes("instinctBlocked(turnAttributes(ctx), slug)"),
    "the COMPOSIO_* family is guarded once, in its shared runner",
  );
  // One definition of "is this an instinct turn", not two.
  assert(
    src("agent/lib/instinct-wake.ts").includes('from "./instinct-guard.ts"'),
    "instinct-wake re-exports the guard's predicate instead of keeping a copy",
  );
}

// --- the live tab is not evidence of intent ---------------------------------

{
  const tool = src("agent/tools/browser_task.ts");
  assert(
    tool.includes('source: "errand" | "live-tab"'),
    "continuationPayHosts says WHERE the host came from",
  );
  assert(
    /guessed\.source === "live-tab"[\s\S]{0,400}status: "needs_pay_host"/.test(tool),
    "and a live-tab host becomes a question instead of a card binding",
  );
  const hint = payHostConfirmHint("lamoda.ru");
  assert(hint.includes("lamoda.ru"), "the question names the host out loud");
  assert(/Спроси человека/.test(hint), "asks the person");
  assert(/ничего не запускай/.test(hint), "and stops until they answer");
  assert(
    hint.includes('pay.hosts: ["lamoda.ru"]'),
    "then tells the model exactly how to resume once they say yes",
  );
}

console.log("unattended-check ok");
