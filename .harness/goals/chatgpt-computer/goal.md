# Goal: ChatGPT OAuth + личный компьютер

Дизайн: `docs/superpowers/specs/2026-09-07-bro-chatgpt-computer-design.md`.
Уточнение плана: Fable 5.1 против eve 0.47.6 (2026-09-08).

Если у тенанта есть живой Codex-вход и ход не групповой — корень
(и по возможности worker/otp) думает через этот вход. Иначе
OpenRouter. Модель резолвится на `step.started`, не на `turn.started`.
У каждого Convex-тенанта один **box (ASCII)**. `boxId` в Convex.
Токены в сейфе; на машину — `auth.json` без refresh. Мозг Bro не
через `box.prompt`.

Порядок: P0 spike + mock → P1 computer tools → P2 ChatGPT +
динамическая модель → P3 user MCP/CLI.
