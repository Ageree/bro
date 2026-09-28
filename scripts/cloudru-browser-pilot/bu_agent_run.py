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
parser.add_argument("--screenshot")
parser.add_argument("--allowed-domains", help="comma-separated, e.g. ozon.ru,*.ozon.ru; keeps the agent on the site")
args = parser.parse_args()
faulthandler.dump_traceback_later(args.deadline, exit=True)


def fresh_tab(cdp_url):
    """Leave one blank tab: with allowed_domains, a leftover tab on another site stalls BrowserSession start."""
    import urllib.request

    pages = [t for t in json.load(urllib.request.urlopen(cdp_url + "/json/list")) if t.get("type") == "page"]
    urllib.request.urlopen(urllib.request.Request(cdp_url + "/json/new?about:blank", method="PUT")).read()
    for page in pages:
        urllib.request.urlopen(cdp_url + "/json/close/" + page["id"]).read()


async def main():
    started = time.perf_counter()
    result = {"engine": "browser-use-agent", "model": args.model, "url": args.url, "goal": args.goal}
    allowed = [d.strip() for d in args.allowed_domains.split(",")] if args.allowed_domains else None
    if allowed and os.environ.get("BU_CDP_URL", "http://").startswith("http"):
        fresh_tab(os.environ.get("BU_CDP_URL", "http://127.0.0.1:9222"))
    result["allowed_domains"] = allowed
    session = BrowserSession(cdp_url=os.environ.get("BU_CDP_URL", "http://127.0.0.1:9222"), keep_alive=True,
                             allowed_domains=allowed)
    try:
        agent = Agent(
            task=f"Open {args.url}. {args.goal}",
            # OpenRouter refuses RU addresses; BU_LLM_BASE_URL points at an OpenAI-compatible
            # provider reachable from the VM (RouterAI in the pilot).
            llm=ChatOpenRouter(
                model=args.model,
                base_url=os.environ.get("BU_LLM_BASE_URL", "https://openrouter.ai/api/v1"),
                api_key=os.environ.get("BU_LLM_API_KEY") or os.environ.get("OPENROUTER_API_KEY"),
            ),
            browser_session=session,
            use_vision=False,
            calculate_cost=True,
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
        # Success is judged from the final page, not from the agent's own "done".
        state = await session.get_browser_state_summary(include_screenshot=False)
        result.update(final_url=state.url, title=state.title,
                      visible_text=state.dom_state.llm_representation()[:3000])
        if args.screenshot:
            await session.take_screenshot(path=args.screenshot, format="jpeg", quality=70)
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
