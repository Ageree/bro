# Goal: ChatGPT OAuth + личный компьютер

Дизайн: `docs/superpowers/specs/2026-09-07-bro-chatgpt-computer-design.md`.

Bro остаётся консьержем на OpenRouter. У каждого тенанта — один
persistent Vercel Sandbox (`bro-computer-<tenantId>`). ChatGPT
подключается опционально через Codex device-code OAuth; токены в
сейфе; на машине крутится официальный `codex` CLI. Без подписки
ничего не ломается.

Порядок: P0 spike named-sandbox → P1 computer tools → P2 ChatGPT
connect → P3 user MCP/CLI. P4 (eve на Codex Responses) только по
отдельному разрешению.
