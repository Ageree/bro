import json, os, sys, time, urllib.request
KEY = os.environ["ROUTERAI_API_KEY"].strip().strip("“”‘’«»\"' ")
tools = [{"type": "function", "function": {"name": "send_message", "description": "Send a message to the person.",
  "parameters": {"type": "object", "properties": {"kind": {"type": "string", "enum": ["reply", "status"]}, "replyTo": {"type": "string"}, "text": {"type": "string"}}, "required": ["kind", "text"], "additionalProperties": False}}},
  {"type": "function", "function": {"name": "browser_task", "description": "Start a browser errand.",
  "parameters": {"type": "object", "properties": {"action": {"type": "string", "enum": ["start", "status"]}, "task": {"type": "string"}, "site": {"type": "string"}}, "required": ["action"], "additionalProperties": False}}}]
hist = "\n".join(f"Сообщение {i}: обсуждали покупки, погоду и планы на выходные." for i in range(1500))
msgs = [{"role": "system", "content": "Ты Бро, личный помощник. Отвечай по-русски коротко.\n" + hist},
        {"role": "user", "content": "Найди мне на Озоне наушники JBL до 5000 рублей"}]
def call(host, choice):
    body = {"model": "deepseek/deepseek-v4.1-flash", "messages": msgs, "tools": tools, "tool_choice": choice, "reasoning": {"enabled": False},
            "provider": {"order": [host], "allow_fallbacks": False}, "usage": {"include": True}}
    t0 = time.time()
    r = urllib.request.Request("https://routerai.ru/api/v1/chat/completions", data=json.dumps(body).encode(), headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try: a = json.load(urllib.request.urlopen(r, timeout=120))
    except Exception as e: return {"host": host, "err": str(e)[:200]}
    m = (a.get("choices") or [{}])[0].get("message", {})
    tc = m.get("tool_calls") or []
    return {"host": host, "served": a.get("provider"), "choice": choice, "sec": round(time.time() - t0, 2), "in": a.get("usage", {}).get("prompt_tokens"),
            "cost": a.get("usage", {}).get("cost"), "calls": [(t["function"]["name"], t["function"]["arguments"][:150], t.get("id")) for t in tc], "text": (m.get("content") or "")[:80], "err": a.get("error")}
for host in sys.argv[1:]:
    for choice in ["required", "required", "auto"]:
        print(json.dumps(call(host, choice), ensure_ascii=False))
