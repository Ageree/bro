# media — состояние

Ветка `claude/speed2-media` от `origin/bro-next`. Релиз прода на старте: 20261019-073837-4ed026cf.

## Найдено
- `carriesMedia` (runinfra.ts) смотрит все сообщения вызова: фото в истории → весь чат в RouterAI.
  Проверено ходом: текст после фото — все шаги RouterAI (один шаг 5,9 с).
- eve `hydrateSandboxAttachments` (harness/tool-loop.js) читает вложения истории из песочницы
  перед каждым вызовом модели — и PDF прошлых ходов, которые middleware потом всё равно режет.
- STT: `qwen/qwen3-asr-flash-2026-02-10` у RouterAI — 503 «No available providers»; каждое
  голосовое ждёт отказ (~0,5 с) и уходит в whisper-large-v3-turbo (1,8–2,9 с на 6,7 с речи).
- Новый чат с файлом: step.started:0 позже (фото +1 с, PDF +3,5 с) — песочница/staging.

## Сделано (не закоммичено)
- Флаг EARLIER_PHOTOS_WORKSPACES: фото прошлых ходов → строка с путём (staged-files/prompt.ts).
- STT: whisper-large-v3-turbo основной, gpt-4o-transcribe запасной.
- latency.ts: --file, started.

## Дальше
- Серия «до»: scratchpad/before (series.sh, logs.sh, analyze.py).
