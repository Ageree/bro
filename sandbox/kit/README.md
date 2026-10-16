# brokit — набор файловых команд task-агента

Чистый Python поверх того, что уже есть в образе песочницы (`sandbox/image/requirements.txt`:
pypdf, reportlab, Pillow, numpy, openpyxl, python-docx, python-pptx, pandas, lxml; poppler-utils,
LibreOffice). Образ не меняется: набор едет в песочницу хуком по хэшу содержимого
(`agent/lib/sandbox/kit.ts`), в песочницу Бро — свежей копией на каждый вызов подписи.

`brokit <группа> <команда> …` печатает одну строку JSON. Код выхода: 0 — готово, 2 — отказ
(`code`, `error`, `hint`), 1 — ошибка набора, 3 — набор устарел или не доставлен (boot).
Список команд — `brokit --help` и таблица `COMMANDS` в `brokit/cli.py`.

Тесты: Python 3.10 с зависимостями образа —
`python -m venv /tmp/kit && /tmp/kit/bin/pip install --require-hashes --only-binary=:all: -r ../image/requirements.txt`,
затем `/tmp/kit/bin/python -m unittest discover -s tests -t .` из этого каталога.
