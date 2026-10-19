# Состояние единицы «yandex»

- Ветка `claude/speed3-yandex` (от bro-next e76594d). PR пробы: #522 (`claude/speed3-yandex-probe`).
- Замер «до»: батч 20:00 UTC (op-режим ×3: afisha.tickets, food.eda_orders, food.eda_cart,
  market.orders, market.cart, maps.search, status) + page-режим на robots.txt.
- Кандидаты на лёгкую страницу: afisha.tickets, food.eda_cart/orders/menu,
  market.product/cart/orders/order. Карты — опыт с пустым csrf и своим sessionId.
- status оставить: ему нужен редирект id.yandex.ru на вход.
- Результаты и логи — scratchpad (`res/`, `times.tsv`), не в репозиторий.
- Следующий шаг: итог батча → правка origin → черновой PR.
