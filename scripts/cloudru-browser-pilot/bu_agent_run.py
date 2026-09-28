"""Run open-source Browser Use Agent against the local Chrome (CDP) and print a JSON summary."""

import argparse
import asyncio
import faulthandler
import json
import os
import time

from browser_use import Agent, BrowserSession, ChatOpenRouter

parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True)
parser.add_argument("--goal", required=True)
parser.add_argument("--model", default=os.environ.get("BU_AGENT_MODEL", "deepseek/deepseek-v4.1-flash"))
parser.add_argument("--max-steps", type=int, default=20)
parser.add_argument("--deadline", type=int, default=420)
args = parser.parse_args()
faulthandler.dump_traceback_later(args.deadline, exit=True)


async def main():
    started = time.perf_counter()
    result = {"engine": "browser-use-agent", "model": args.model, "url": args.url, "goal": args.goal}
    session = BrowserSession(cdp_url=os.environ.get("BU_CDP_URL", "http://127.0.0.1:9222"), keep_alive=True)
    try:
        agent = Agent(
            task=f"Open {args.url}. {args.goal}",
            llm=ChatOpenRouter(model=args.model),
            browser_session=session,
            use_vision=False,
        )
        history = await agent.run(max_steps=args.max_steps)
        result.update(
            status="done" if history.is_done() else "not_done",
            successful=history.is_successful(),
            steps=history.number_of_steps(),
            final_result=(history.final_result() or "")[:3000],
            urls=[u for u in history.urls() if u][-5:],
            errors=[e for e in history.errors() if e][:5],
            agent_seconds=round(history.total_duration_seconds(), 2),
        )
        usage = getattr(history, "usage", None)
        if usage is not None:
            result["usage"] = usage.model_dump() if hasattr(usage, "model_dump") else str(usage)
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
