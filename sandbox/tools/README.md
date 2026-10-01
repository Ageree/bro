# CLI `tools`

Клиент маршрутизатора инструментов Бро внутри песочницы (контракт —
`../README.md`, разделы «Брокер инструментов и GraphQL» и «CLI `tools`»). Сети
в песочнице нет: CLI шлёт GraphQL по HTTP/1.1 в unix-сокет брокера `sandboxd`
(`/run/bro/tools.sock`, путь переопределяет `BRO_TOOLS_SOCKET`), а брокер
добавляет токен и пересылает запрос маршрутизатору. Секретов у CLI нет.

## Сборка

Статический бинарник на musl, без HTTP-библиотек и рантаймов: HTTP/1.1 поверх
`UnixStream` и base64 написаны вручную, зависимость одна — `serde_json`.

```sh
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl
# target/x86_64-unknown-linux-musl/release/tools — около 550 КБ, без glibc
```

Проверка:

```sh
cargo test        # юнит-тесты и CLI против поддельного брокера на сокете
TOOLS_BIN=$PWD/target/x86_64-unknown-linux-musl/release/tools cargo test --test cli
cargo clippy --all-targets -- -D warnings
```

## Использование

```sh
tools                                    # список «имя — описание»
tools web-search --help                  # описание, короткая форма, JSON-схема
tools web-search '{"query": "погода в Москве"}'
echo '{"query": "погода"}' | tools web-search
tools web-search "погода в Москве" --sites yandex.ru/maps --sites 2gis.ru
tools download https://example.com/a.pdf /workspace/docs/  # → docs/a.pdf
```

- Имена показываются в kebab-case (`web-search`), принимаются и `web_search`.
- Короткая форма: позиционные аргументы заполняют `required` схемы по порядку;
  `--key value` и `--key=value` задают свойство по имени (`--max-results` —
  `max_results` или `maxResults`). Числа и булевы значения разбираются по типу
  в схеме; массив — повтором флага или JSON (`--sites '["a.ru","b.ru"]'`);
  `--flag` и `--no-flag` — для булевых; `--` завершает флаги. Короткой форме
  нужен лишний запрос за схемой, JSON целиком — один запрос.
- `download` пишет файл сам: `<путь>` — файл; каталог (существующий или с `/`
  в конце) — имя файла с сайта; без пути — в текущий каталог.

| Код | Когда                                                                |
| --- | -------------------------------------------------------------------- |
| 0   | `ok: true`: `output`-строка печатается как есть, остальное — JSON    |
| 1   | `ok: false` (текст `error` — в stderr), ошибки GraphQL и HTTP, ввод  |
| 2   | нет сокета или брокер не отвечает (подключение — 5 с, ответ — 150 с) |
| 3   | брокер ответил 429: больше 120 запросов в минуту на песочницу        |
