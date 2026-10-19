# browser — состояние

Ветка `claude/speed2-browser` от bro-next 4ed026c. Релиз прода при замерах: 20261019-073837-4ed026cf.

## Цифры «до» (прод)
- browser-runs.sh 08.10–19.10: 84 запуска, все Together (пилот владельца): p50 153 с, p90 376 с, 25 шагов × 6,0 с, 6,37 ₽.
- 28.09–08.10 DeepInfra (без пилота): 69 запусков, p50 299 с, 24 шага × 12,2 с, 2,69 ₽.
- WB-чайник (errand-latency): heads-up 5,4 с, browser_task 8,8 с, запуск ~91 с, settle→отчёт 18 с, итог 121 с.
- Чужие тесты на том же аккаунте: run settled → report delivery 12 с; queued errand стартовал через 44 с после освобождения браузера.

## Сделано
- hurryQueuedBrowserRuns + вызов в settle (completion.ts), тесты.
- settle timing лог.
- scripts/bench/errand-latency.ts.

## Дальше
- серия s2 (кино, Леруа, кафе), повторы; описание PR.
