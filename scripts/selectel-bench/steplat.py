"""Measure TTFT / total / output tok/s for a browser-use-like step on RouterAI (streaming)."""
import json, os, random, sys, time, urllib.request
KEY = os.environ["ROUTERAI_API_KEY"].strip().strip("“”‘’«»\"' ")
random.seed(7)
words = "Купить Корзина Доставка Отзывы Цена руб Смартфон Наушники Чехол Кабель Зарядка Ноутбук Войти Каталог Акции Распродажа Бесплатно завтра Рейтинг Продавец Скидка".split()
dom = "\n".join(f"[{i}]<{random.choice(['a','button','div','span','input'])} {random.choice(['','role=link','aria-label='+random.choice(words)])}>{' '.join(random.choice(words) for _ in range(random.randint(2,9)))} {random.randint(199,99999)} ₽</>" for i in range(int(sys.argv[2]) if len(sys.argv) > 2 else 600))
system = ("You are a browser automation agent. Each step you receive the browser state (interactive elements with [index]) and must output JSON: "
          '{"thinking": str, "evaluation_previous_goal": str, "memory": str, "next_goal": str, "action": [ {"click": {"index": int}} | {"input": {"index": int, "text": str}} | {"navigate": {"url": str}} | {"done": {"text": str, "success": bool}} ]}. '
          "Be concise. Output only JSON.\n" + "Rules: " + " ".join(["Prefer the cheapest offer with rating above 4.5 and delivery tomorrow."] * 40))
user = f"<user_request>Найди самые дешёвые беспроводные наушники с доставкой завтра и рейтингом выше 4.5</user_request>\n<agent_history>step 1: navigated to market; step 2: searched 'беспроводные наушники'</agent_history>\n<browser_state>Current url: https://market.example/search?text=наушники\n{dom}\n</browser_state>"
def run(model, provider, flash):
    body = {"model": model, "stream": True, "max_tokens": 700, "temperature": 0,
            "messages": [{"role": "system", "content": system + (" Flash mode: output only memory and action, no thinking." if flash else "")}, {"role": "user", "content": user}],
            "usage": {"include": True}}
    if provider: body["provider"] = {"order": [provider], "allow_fallbacks": False}
    if model.startswith("deepseek"): body["reasoning"] = {"enabled": False}
    if "gpt-oss" in model or "minimax" in model or "qwen3.8" in model: body["reasoning"] = {"effort": "low"}
    if os.environ.get("NOREASON"): body["reasoning"] = {"enabled": False}
    req = urllib.request.Request("https://routerai.ru/api/v1/chat/completions", data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    t0 = time.time(); ttft = None; text = ""; usage = None; prov = None; err = None
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            for line in r:
                line = line.decode().strip()
                if not line.startswith("data:") or line == "data: [DONE]": continue
                d = json.loads(line[5:])
                if "error" in d: err = d["error"]; break
                prov = d.get("provider", prov)
                for c in d.get("choices", []):
                    delta = c.get("delta", {})
                    piece = (delta.get("content") or "") + (delta.get("reasoning") or "")
                    if piece and ttft is None: ttft = time.time() - t0
                    text += piece
                if d.get("usage"): usage = d["usage"]
    except Exception as e: err = str(e)[:200]
    tot = time.time() - t0
    out_t = (usage or {}).get("completion_tokens"); in_t = (usage or {}).get("prompt_tokens")
    gen = (tot - ttft) if ttft else None
    return {"model": model, "provider": prov, "flash": flash, "in": in_t, "out": out_t, "ttft": ttft and round(ttft, 2), "total": round(tot, 2),
            "out_tps": round(out_t / gen, 1) if out_t and gen else None, "cost": (usage or {}).get("cost"), "err": err, "head": text[:120]}
if __name__ == "__main__":
    model, provider = sys.argv[1], (sys.argv[3] if len(sys.argv) > 3 else None)
    flash = len(sys.argv) > 4 and sys.argv[4] == "flash"
    print(json.dumps(run(model, provider, flash), ensure_ascii=False))
