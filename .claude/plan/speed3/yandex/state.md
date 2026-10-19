# Состояние единицы «yandex»

- Ветка `claude/speed3-yandex`. PR пробы: #522 (слит, в релизе 20261019-194811-b905f367),
  #527 (повтор запросов пробы к S3: 13/31 запусков падали ETIMEDOUT VM→S3).
- «До» (20:12–20:25 UTC, релиз b905f367, op-режим, callMs): afisha.tickets 5467/2649/3078;
  eda_orders 2039/12456/1677; eda_cart 1059/1425; market.orders 3671/3919;
  market.cart 4508/3080; status 1416/1366; maps.search 2212 ok, затем 2× captcha.
- Лёгкая страница (page-режим, загрузка + функция, мс): afisha.tickets 372–834 + 453–618,
  совпало ×6; eda_orders 10666(!) + 354–902, совпало; eda_cart 607 + 216–495, совпало;
  market.cart 731 + ~500, совпало; market.orders 723 + 552–565, совпало, но 1-й вызов раз
  `bad_response` — перепроверить.
- Карты: на robots.txt fetch("/maps/") → no_session; в op-режиме 2 из 3 — капча.
  Синтетическая сессия не проверена (S3).
- direct: не проверено (S3 ETIMEDOUT) — повтор в 21:00 / после #527.
- 21:00: market.search→product, market.orders→order, eda_search→menu; повтор market.orders light.
