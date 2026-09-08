# Goal: ChatGPT OAuth + личный компьютер

Дизайн: `docs/superpowers/specs/2026-09-07-bro-chatgpt-computer-design.md`.

Если у тенанта есть живой Codex-вход — весь Bro (корень, worker,
otp) думает через этот вход. Если входа нет — OpenRouter как
сейчас. У каждого тенанта один persistent **box (ASCII)**. `boxId`
в Convex. Токены в сейфе; на машине тот же вход лежит в
`~/.codex/auth.json`. Мозг Bro не через `box.prompt`.

Порядок: P0 spike box create/stop/resume → P1 computer tools →
P2 ChatGPT connect + динамическая модель → P3 user MCP/CLI.
