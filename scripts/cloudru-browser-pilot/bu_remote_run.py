"""Browser Use Agent outside the VM driving the VM's Chrome over CDP (`vm.py cdp`), JSON summary on stdout.

The model is called from where this runs, so OpenRouter works even though it refuses Cloud.ru addresses;
sites still see the VM's address. `--skill FILE` appends a skill (Markdown) to the agent's system prompt,
with a note that maps the skill's Chrome-extension tools onto Browser Use actions.
"""

import argparse
import asyncio
import faulthandler
import json
import os
import time
from collections import Counter
from pathlib import Path

from browser_use import Agent, BrowserSession, ChatOpenRouter

parser = argparse.ArgumentParser()
parser.add_argument("--cdp", required=True, help="wss URL printed by `vm.py cdp`")
parser.add_argument("--url", required=True)
parser.add_argument("--goal", required=True)
parser.add_argument("--model", default="deepseek/deepseek-v4.1-flash")
parser.add_argument("--skill")
parser.add_argument("--max-steps", type=int, default=30)
parser.add_argument("--deadline", type=int, default=720)
args = parser.parse_args()
faulthandler.dump_traceback_later(args.deadline, exit=True)

SKILL_PREAMBLE = """<skill>
The skill below was written for a Chrome extension. In this agent its tools map to your actions:
`javascript_tool` is `evaluate` (return a short string, e.g. JSON.stringify of the data); `navigate` is
`navigate`; `read_network_requests` does not exist, so find the page's API from window globals, `<script>`
tags or `performance.getEntriesByType('resource')` via `evaluate`; screenshots, clipboard, file downloads,
Python and subagents are not available: return extracted data through `evaluate` and put it into `done`.
The PII output filter does not apply here.

"""


async def main():
    started = time.perf_counter()
    result = {"engine": "browser-use-remote", "model": args.model, "skill": Path(args.skill).name if args.skill else None,
              "url": args.url, "goal": args.goal}
    session = BrowserSession(cdp_url=args.cdp, keep_alive=True)
    try:
        extra = SKILL_PREAMBLE + Path(args.skill).read_text() + "\n</skill>" if args.skill else None
        agent = Agent(
            task=f"Open {args.url}. {args.goal}",
            # The environment key arrives with line breaks inside (see clean() in vm.py).
            llm=ChatOpenRouter(model=args.model, api_key="".join(os.environ["OPENROUTER_API_KEY"].split())),
            browser_session=session,
            use_vision=False,
            extend_system_message=extra,
        )
        history = await agent.run(max_steps=args.max_steps)
        actions = [a for a in history.action_names() if a]
        result.update(
            status="done" if history.is_done() else "not_done",
            successful=history.is_successful(),
            steps=history.number_of_steps(),
            actions=dict(Counter(actions)),
            final_result=history.final_result() or "",
            urls=[u for u in history.urls() if u][-5:],
            errors=[e[:300] for e in history.errors() if e][:5],
            agent_seconds=round(history.total_duration_seconds(), 2),
        )
        state = await session.get_browser_state_summary(include_screenshot=False)
        result.update(final_url=state.url, title=state.title)
        usage = getattr(history, "usage", None)
        if usage is not None:
            result["usage"] = {k: getattr(usage, k, None) for k in
                               ("total_prompt_tokens", "total_prompt_cached_tokens", "total_completion_tokens")}
    except Exception as e:  # report, never hide
        result.update(status="error", error=f"{type(e).__name__}: {e}"[:2000])
    finally:
        try:
            await session.stop()
        except Exception:
            pass
    result["total_ms"] = round((time.perf_counter() - started) * 1000)
    print(json.dumps(result, ensure_ascii=False, default=str))


asyncio.run(main())
