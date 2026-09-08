# Goal: ChatGPT OAuth + личный компьютер

Дизайн: `docs/superpowers/specs/2026-09-07-bro-chatgpt-computer-design.md`.

Если у тенанта есть живой Codex-вход — весь Bro (корень, worker,
otp) думает через этот вход. Если входа нет — OpenRouter как
сейчас. У каждого тенанта один persistent Vercel Sandbox
(`bro-computer-<tenantId>`). Токены в сейфе; на машине тот же
вход лежит в `~/.codex/auth.json`.

Порядок: P0 spike named-sandbox → P1 computer tools → P2 ChatGPT
connect + динамическая модель → P3 user MCP/CLI.
