# Бенчмарк скорости браузерных поручений на Selectel

Скрипты замеров 05.10 из `docs/browser-speed.md`: шаг LLM на хостах RouterAI,
VM Selectel, Chrome и профиль, browser-use 0.13.10 с настройками worker Бро.

## Как устроено

Из облачной сессии до VM доходит только HTTP на :80, SSH закрыт. HTTP-агент,
исполняющий команды на VM, классификатор auto mode запрещает («Create RCE
Surface»). Поэтому VM получает всю работу через cloud-init (`userdata.tpl.sh`)
и отдаёт результаты только на чтение: `log.txt`, `chrome*.json`, `bu.jsonl` и
`bu-stdout.txt` из `/var/www/bench`. Следующая итерация — `rebuild` VM с новыми
user data. VM с сетевым диском `rebuild` не переписывает, её создают заново.

Ключ RouterAI едет в user data и лежит в метаданных VM. Скрипт стирает свою
копию в конце, а VM после замеров удаляют (`sel.py down`). Ключ облачной
сессии — это ключ прода: потраченное здесь уходит с баланса Бро.

## Шаги

```sh
export SELECTEL_TOKEN=… SELECTEL_PROJECT=…   # статический ключ и id проекта
python3 build_userdata.py /tmp/ud-hfl.sh hfl dst_full,ds_full,dst_flash,ds_flash market,wb,avito,rasp,ozon 55
python3 sel.py up bench-hfl HFL1.4-8192-90 ru-7b /tmp/ud-hfl.sh            # печатает IP
python3 build_userdata.py /tmp/ud-prc10.sh prc10 dst_full,ds_flash market,wb,avito,rasp,ozon 12
python3 sel.py up bench-prc10 PRC10.4-8192 ru-7a /tmp/ud-prc10.sh --volume
python3 analyze.py hfl=<ip> prc10=<ip>                                      # когда в log.txt есть bu-done
python3 sel.py down
```

- `steplat.py MODEL DOM_ITEMS [HOST] [flash]` — один шаг, похожий на шаг
  browser-use (~20 тыс. токенов), с потоком: TTFT, итог, ток/с, цена.
- `forced.py HOST…` — принудительный вызов инструмента основного агента
  (`tool_choice: required`) на хосте DeepSeek.
- `life.py NAME IP` — выключение, включение и перезагрузка VM до ответа
  сервиса (`life-userdata.sh`).

Конфигурации и задачи — `CONFIGS` и `TASKS` в `bu_bench.py`. Бюджет на VM
делится поровну между конфигурациями; конфигурация, превысившая свою долю в
полтора раза, пропускается.
