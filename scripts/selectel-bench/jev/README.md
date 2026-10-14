# Стенд для замера Jev 1.14 на браузерных задачах

Гоняет [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (коммит `1231850`, код не правится: вместо
browser-harness стоит шим CDP) на машине Selectel. Три варианта: Jev 1.13, 1.14 и 1.14 со скриншотом страницы в `state`.
Текстовый помощник для полей — `inception/mercury-2.5` через RouterAI, как в README jev-ultrafast. Отдельно `box_bench.py`
проверяет, попадает ли Box-вопрос Jev 1.14 в элементы на скриншотах настоящих страниц. Успех решает проверка итоговой страницы
(`tasks.py`), а не DONE агента. Базу browser-use (`run_bu.py`, `ARMS=bu_dst_flash,bu_ds_full`) в запуск не включают сами.

## Статус (14.10)

Не запускался на Selectel: из России Jev 1.14 недоступен. `api.typesafe.ai` отвечает 451, а RouterAI отдаёт только
`typesafe/jev-1.13` и теряет картинки. Запускайте, когда RouterAI добавит 1.14 с `assets` (проверка — ниже).

## Запуск

```sh
git clone https://github.com/browser-use/jev-ultrafast && git -C jev-ultrafast checkout 1231850
export JEV_SRC=$PWD/jev-ultrafast SELECTEL_PROJECT=… SELECTEL_API_KEY=…
JEV_VIA=routerai python3 build.py /tmp/ud.gz            # ключ Jev — ROUTERAI_API_KEY; без JEV_VIA — TYPESAFE_API_KEY
python3 ../sel.py up bench-jev HFL1.4-8192-90 ru-7b /tmp/ud.gz   # печатает IP
curl http://<ip>/log.txt                                # ход; runs.jsonl и box.jsonl — результаты
python3 ../sel.py down
```

Перед запуском проверьте RouterAI: запрос `typesafe/jev-1.14` с картинкой должен показать во входе ~2,5 тыс. токенов
(на 1.13 было 348 — картинка потерялась). Ключи едут в user data и лежат в метаданных VM: после замеров VM удалить.
