# Общие правила трёх исполнителей (холодный путь сайтов, 26.10)

Координатор — другая облачная сессия. Она раздала три независимых исправления быстрого
пути поиска на сайтах (`agent/lib/browser-vm/site-ops/`, `browser-vm/worker/worker.py`),
каждое — своей сессии. Ты делаешь ровно своё задание (файл рядом) и ничего сверх него.

## Что прочитать сначала

- `CLAUDE.md` → `AGENTS.md` и `docs/dev-notes.md` (загружены в сессию сами). В dev-notes
  раздел «Браузерные поручения», записи с «Операции сайтов», «Второй поиск на сайте — без
  поручения», «Первый поиск без браузера», «Первый поиск строкой самого сайта», «Город сайта»,
  «Шаблоны операций», «Сайты без чистого JSON-запроса», «Входы сайта», «Самолечение операций».
- Код: `browser-vm/worker/worker.py` — `site_look`, `site_search_page`/`site_search_on`,
  `site_op_direct`, `site_rows_landed`, `site_same_place`, `site_same_path`, `SiteTraffic`;
  Бро — `agent/lib/browser-vm/site-ops/direct.ts` (`lookSite`, `lookWay`, `readSiteDirectly`),
  `operation.ts`, `health.ts`, `agent/lib/browser-vm/worker.ts` (`/v1/op`, `/v1/look`).
- Тесты: `browser-vm/worker/test_site_ops.py` (в т.ч. `SearchChromeTest`, `RowsChromeTest` —
  на настоящем Chromium по `BRO_SITE_ROWS_CHROME`), `browser-vm/worker/test_names.py` (pyflakes),
  `tests/agent/browser-vm/site-direct.test.ts`, `tests/agent/browser-vm/site-ops*.test.ts`.

## Правила

- Работай только в своей ветке (имя — в задании), один draft PR в `bro-next`.
  Коммиты и заголовок PR — по-русски, с точки зрения пользователя. Никаких имён моделей
  в коммитах, PR и коде.
- Не сливай, не выкатывай, не публикуй worker, не трогай env прода (`host.py`, `prod.json`,
  `state save`), не пиши координатору через `send_message` (это вешает сессию). Координатор
  сам следит за PR.
- `VERSION` в `worker.py` — только номер из твоего задания. Он у каждой сессии свой; конфликт
  этой строки при слиянии решит координатор.
- В `worker.py` меняй только нужное: не переставляй и не переформатируй чужой код — две другие
  сессии правят тот же файл в соседних местах.
- Баг-фикс — с тестом, который падал до правки. Прогоны на живых сайтах — стенд из облачной
  сессии: настоящий worker и Chromium через прокси сессии (выход США; часть российских сайтов
  его не пускает — тогда моделируй сайт локальной страницей в Chromium-тесте, как
  `SearchChromeTest`). Живой прод и аккаунты людей не трогай.
- Проверки перед пушем: `python -m unittest` нужных тестов в `browser-vm/worker`
  (с pyflakes: `pip install pyflakes==4.0.3`), vitest затронутых тестов
  (`./node_modules/.bin/vitest run <файлы>`; env-ловушки сессии — в dev-notes, раздел «Процесс»:
  `env -u TELEGRAM_BOT_USERNAME -u IMESSAGE_PROJECT_ID -u OPS_ALERT_BOT_TOKEN -u OPS_ALERT_CHAT_ID`),
  `pnpm exec oxfmt` и oxlint на изменённых TS, `tsc` при правке типов. Полный `pnpm check` гоняет CI.
  Node 24 и `pnpm install` — по dev-notes («В свежей облачной сессии нет node_modules»).
- Добавь в `docs/dev-notes.md` короткую запись (пара строк: факт, почему, где смотреть) в том же PR.
- Решения по ходу принимай сам: выбирай более простое и обратимое, причину — в описание PR.
- PR: что меняется для людей, чем проверено (цифры стенда), как откатить, что осталось.
  Дождись зелёного CI на своём PR; красный — найди причину и исправь. Потом закончи ход.
