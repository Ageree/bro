# report — состояние

Ветка `claude/speed3-report`; ops-PR #523 (`claude/speed3-report-net`, net-latency S3 v4/v6).

## Находки

- С выката 19:03 UTC 19.10 каждый финальный скриншот отчёта падает за ~0,3 с:
  S3 PUT `fetch failed` → AggregateError ETIMEDOUT (happy-eyeballs 250 мс; у S3 A+AAAA).
  imagesMs сейчас 0,29–0,31 с, но картинок 0. В 18:11 тот же путь — 4,0 с и 1 картинка.
- Картинки уже качаются параллельно; время — download с worker + S3 PUT (разбивки в логе не было).

## Сделано

- S3 PUT: один повтор при сетевом сбое, через Agent с autoSelectFamilyAttemptTimeout 2,5 с (без флага, тест).
- Строка `[browser-use] run image timing` (downloadMs, storeMs, bytes).
- Флаг BROWSER_REPORT_FAST_WORKSPACES: без фото товаров отчёт ждёт картинку страницы ≤ 2 с.

## «До» (19.10 ~19:3x)

см. описание PR.

## Дальше

- замер #521 «после» (две пары с разницей 20 с), комментарий в #521;
- PR, проверки, dev-notes.
