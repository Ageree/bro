"""Deterministic data behind the f-* file cases (cases.json).

Every number a check in cases.json compares against comes from a function
here, so a fixture renderer and the checker share one source of truth.
Only random.Random(seed).random()/randrange() are used: both are stable
across CPython 3.x. All names, companies, accounts and IDs are fictional
(SPECIMEN / ОБРАЗЕЦ). Run `python3 datagen.py` to print the expected values.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import random
from collections import Counter, defaultdict

D = dt.date

# ---------------------------------------------------------------- f-xlsx-sales-traps

SALES_MANAGERS = ["Иванов И.И.", "Петрова А.С.", "Сидоров К.М.", "Ким Е.В."]
SALES_MANAGER_VARIANTS = {
    "Иванов И.И.": ["Иванов И.И.", "Иванов", " иванов ", "ИВАНОВ И. И."],
    "Петрова А.С.": ["Петрова А.С.", "Петрова", "петрова а.с. ", "Петрова  А. С."],
    "Сидоров К.М.": ["Сидоров К.М.", "Сидоров", "сидоров к.м.", "Сидоров К. М. "],
    "Ким Е.В.": ["Ким Е.В.", "Ким", " КИМ Е.В.", "Ким Е. В."],
}
SALES_CLIENTS = [
    ("ООО «Альфа-Образец»", "Москва"), ("ИП Тестов А.А.", "Казань"),
    ("ООО «Бета-Пример»", "Санкт-Петербург"), ("АО «Гамма-Демо»", "Новосибирск"),
    ("ООО «Дельта-Макет»", "Екатеринбург"), ("ООО «Эпсилон-Шаблон»", "Москва"),
    ("ИП Примеров Б.Б.", "Самара"), ("ООО «Зета-Специмен»", "Пермь"),
    ("ООО «Эта-Образец»", "Москва"), ("АО «Тета-Тест»", "Казань"),
    ("ООО «Йота-Пример»", "Тюмень"), ("ООО «Каппа-Демо»", "Воронеж"),
]
MONTH_ABBR = {1: "янв.", 2: "февр.", 3: "мар."}


def sales_q1(seed: int = 4):
    """Raw rows per sheet, with traps. Each row: dict(kind=deal|dup|subtotal|total, ...)."""
    rnd = random.Random(seed)
    counts = {1: 40, 2: 38, 3: 45}
    deals = []  # canonical unique deals
    n = 0
    for m in (1, 2, 3):
        days = 31 if m in (1, 3) else 28
        for _ in range(counts[m]):
            n += 1
            day = 1 + rnd.randrange(days)
            mgr = SALES_MANAGERS[rnd.randrange(4)]
            client, city = SALES_CLIENTS[rnd.randrange(len(SALES_CLIENTS))]
            amount = rnd.randrange(500_000, 25_000_000) / 100
            deals.append(dict(no=f"С-26-{n:04d}", date=D(2026, m, day), manager=mgr,
                              client=client, city=city, amount=amount, status="оплачено"))
    # 2 cancelled per month (fixed picks)
    for m in (1, 2, 3):
        ms = [d for d in deals if d["date"].month == m]
        for d in (ms[3], ms[17]):
            d["status"] = "отменена"
    for d in deals:
        d["sheet"] = d["date"].month
    # duplicates: 5 within-sheet, 2 cross-sheet (Jan deals repeated in Feb sheet)
    dups = []
    for idx in (5, 44, 47, 90, 101):
        dups.append(dict(deals[idx], sheet=deals[idx]["sheet"]))
    for idx in (8, 30):
        dups.append(dict(deals[idx], sheet=2))
    return deals, dups


def sales_expected(seed: int = 4):
    deals, dups = sales_q1(seed)
    live = [d for d in deals if d["status"] != "отменена"]
    pivot = defaultdict(float)
    for d in live:
        pivot[(d["manager"], d["date"].month)] += d["amount"]
    pivot = {f"{k[0]}|{k[1]}": round(v, 2) for k, v in sorted(pivot.items())}
    by_mgr = defaultdict(float)
    for d in live:
        by_mgr[d["manager"]] += d["amount"]
    naive = sum(d["amount"] for d in deals) + sum(d["amount"] for d in dups)
    return dict(
        unique_deals=len(deals), cancelled=len(deals) - len(live), clean_rows=len(live),
        duplicates_removed=len(dups), grand_total=round(sum(d["amount"] for d in live), 2),
        naive_sum_with_dups_and_cancelled=round(naive, 2),
        by_manager={k: round(v, 2) for k, v in sorted(by_mgr.items())},
        pivot_manager_month=pivot,
    )


def sales_cell_repr(i: int, d: dict):
    """How row i writes its date/amount/manager (trap mix). Renderer uses this."""
    k = i % 5
    if k == 0:
        date = ("datetime", d["date"].isoformat())
    elif k == 1:
        date = ("text", d["date"].strftime("%d.%m.%Y"))
    elif k == 2:
        date = ("text", d["date"].isoformat())
    elif k == 3:
        date = ("serial_general", (d["date"] - D(1899, 12, 30)).days)
    else:
        date = ("text", f"{d['date'].day} {MONTH_ABBR[d['date'].month]}")
    j = i % 4
    rub, kop = divmod(round(d["amount"] * 100), 100)
    if j == 1:
        amount = ("text", f"{rub:,}".replace(",", " ") + f",{kop:02d}")
    elif j == 2:
        amount = ("text", f"{rub}.{kop:02d} руб.".replace(".", ",", 1))
    else:
        amount = ("number", d["amount"])
    mgr = SALES_MANAGER_VARIANTS[d["manager"]][i % 4]
    return date, amount, mgr


# ---------------------------------------------------------------- f-bank-statement-pdf-categories

BANK_OPENING = 154_215.37
# descriptor, bank category, my category, (min, max) rubles, sign
MERCHANTS = [
    ("PYATEROCHKA 1415 MOSCOW RUS", "Супермаркеты", "Продукты", (180, 2600), -1),
    ("PEREKRESTOK 0231 MOSCOW RUS", "Супермаркеты", "Продукты", (350, 4800), -1),
    ("VKUSVILL 0912 MOSCOW RUS", "Супермаркеты", "Продукты", (240, 3100), -1),
    ("YANDEX.GO MOSCOW RUS", "Транспорт", "Такси и транспорт", (210, 1450), -1),
    ("MOSMETRO TROIKA MOSCOW RUS", "Транспорт", "Такси и транспорт", (63, 63), -1),
    ("YANDEX*EDA MOSCOW RUS", "Рестораны и кафе", "Кафе и доставка еды", (650, 2900), -1),
    ("COFFEE SPECIMEN 12 MOSCOW RUS", "Рестораны и кафе", "Кафе и доставка еды", (190, 560), -1),
    ("APTEKA OBRAZEC 77 MOSCOW RUS", "Аптеки", "Здоровье и аптеки", (230, 3400), -1),
    ("WILDBERRIES MOSCOW RUS", "Прочие операции", "Маркетплейсы", (299, 5900), -1),
    ("OZON.RU MOSCOW RUS", "Прочие операции", "Маркетплейсы", (199, 7400), -1),
]
FIXED_OPS = [
    # date, descriptor, bank category, my category, amount (signed)
    (D(2026, 9, 1), "Перевод для И. Игорь Николаевич (аренда)", "Переводы", "Квартира и ЖКХ", -45_000.00),
    (D(2026, 9, 3), "ЖКУ ЕИРЦ ОБРАЗЕЦ лицевой счёт 0000000", "Коммунальные платежи", "Квартира и ЖКХ", -6_842.17),
    (D(2026, 9, 4), "Оплата услуг мобильной связи +7 900 000-00-00", "Связь", "Связь и подписки", -650.00),
    (D(2026, 9, 5), "Зарплата ООО «Образец Технологии»", "Зарплата", "Доходы", 135_000.00),
    (D(2026, 9, 5), "Перевод на вклад «Образец Накопительный»", "Перевод между своими счетами", "Свои счета (не считать)", -50_000.00),
    (D(2026, 9, 7), "Выдача наличных ATM 000123 MOSCOW", "Выдача наличных", "Наличные", -10_000.00),
    (D(2026, 9, 9), "YANDEX PLUS MOSCOW RUS", "Прочие операции", "Связь и подписки", -399.00),
    (D(2026, 9, 11), "STEAM PURCHASE USD 12.99 BELLEVUE USA", "Прочие операции", "Связь и подписки", -1_243.54),
    (D(2026, 9, 12), "Возврат покупки WILDBERRIES MOSCOW RUS", "Прочие операции", "Маркетплейсы", 1_299.00),
    (D(2026, 9, 14), "Перевод от М. Ольга Петровна", "Переводы", "Переводы людям", 3_500.00),
    (D(2026, 9, 16), "Перевод для С. Павел Андреевич", "Переводы", "Переводы людям", -2_000.00),
    (D(2026, 9, 18), "Домашний интернет ОБРАЗЕЦ-ТЕЛЕКОМ", "Связь", "Связь и подписки", -790.00),
    (D(2026, 9, 20), "Аванс ООО «Образец Технологии»", "Зарплата", "Доходы", 95_000.00),
    (D(2026, 9, 25), "Перевод с вклада «Образец Накопительный»", "Перевод между своими счетами", "Свои счета (не считать)", 20_000.00),
    (D(2026, 9, 27), "Перевод для К. Елена Сергеевна", "Переводы", "Переводы людям", -1_700.00),
]


def bank_ops(seed: int = 5, total: int = 142):
    rnd = random.Random(seed)
    ops = [dict(date=a, desc=b, bank_cat=c, my_cat=d, amount=e) for a, b, c, d, e in FIXED_OPS]
    while len(ops) < total:
        desc, bcat, mcat, (lo, hi), sign = MERCHANTS[rnd.randrange(len(MERCHANTS))]
        day = 1 + rnd.randrange(30)
        amt = lo if lo == hi else rnd.randrange(lo * 100, hi * 100) / 100
        ops.append(dict(date=D(2026, 9, day), desc=desc, bank_cat=bcat, my_cat=mcat, amount=sign * amt))
    for i, o in enumerate(ops):
        o["auth"] = f"{(i * 7919 + 104729) % 1_000_000:06d}"
        o["time"] = f"{8 + (i * 37) % 14:02d}:{(i * 53) % 60:02d}"
    ops.sort(key=lambda o: (o["date"], o["time"], o["auth"]))
    bal = BANK_OPENING
    for o in ops:
        bal = round(bal + o["amount"], 2)
        o["balance"] = bal
    return ops


def bank_expected(seed: int = 5):
    ops = bank_ops(seed)
    by = defaultdict(float)
    for o in ops:
        by[o["my_cat"]] += o["amount"]
    inc = sum(o["amount"] for o in ops if o["amount"] > 0)
    out = sum(o["amount"] for o in ops if o["amount"] < 0)
    real_spend = -sum(o["amount"] for o in ops if o["my_cat"] not in ("Доходы", "Свои счета (не считать)", "Переводы людям") and o["amount"] < 0)
    return dict(
        rows=len(ops), opening=BANK_OPENING, closing=ops[-1]["balance"],
        total_in=round(inc, 2), total_out=round(-out, 2),
        by_my_category_net=dict(sorted((k, round(v, 2)) for k, v in by.items())),
        spend_excl_income_own_transfers_people=round(real_spend, 2),
        marketplaces_net_after_refund=round(by["Маркетплейсы"], 2),
    )


# ---------------------------------------------------------------- f-csv-120k-cp1251

CSV_SHOPS = [f"Образец-маркет №{i}" for i in range(1, 7)]
CSV_PRODUCTS = [
    ("Молоко 3,2% 1 л", "Молочные", 89.90), ("Кефир 1% 900 г", "Молочные", 74.50),
    ("Сыр Российский 45%", "Молочные", 649.00), ("Творог 5% 200 г", "Молочные", 119.90),
    ("Масло сливочное 82,5%", "Молочные", 229.00), ("Сметана 20% 300 г", "Молочные", 109.00),
    ("Хлеб Бородинский", "Хлеб", 62.00), ("Батон нарезной", "Хлеб", 54.90),
    ("Лаваш армянский", "Хлеб", 79.00), ("Багет французский", "Хлеб", 69.90),
    ("Яйцо С1 10 шт", "Бакалея", 129.90), ("Гречка ядрица 900 г", "Бакалея", 119.00),
    ("Рис круглый 900 г", "Бакалея", 109.90), ("Макароны спагетти 450 г", "Бакалея", 89.00),
    ("Сахар 1 кг", "Бакалея", 84.90), ("Мука пшеничная 2 кг", "Бакалея", 109.00),
    ("Масло подсолнечное 1 л", "Бакалея", 139.00), ("Чай чёрный 100 пак.", "Бакалея", 289.00),
    ("Кофе молотый 250 г", "Бакалея", 449.00), ("Соль 1 кг", "Бакалея", 29.90),
    ("Курица охл. 1 кг", "Мясо", 299.00), ("Фарш говяжий 500 г", "Мясо", 349.00),
    ("Колбаса докторская 400 г", "Мясо", 319.00), ("Сосиски молочные 450 г", "Мясо", 229.00),
    ("Свинина шея 1 кг", "Мясо", 549.00), ("Филе индейки 1 кг", "Мясо", 589.00),
    ("Сёмга с/с 200 г", "Рыба", 699.00), ("Минтай с/м 1 кг", "Рыба", 279.00),
    ("Креветки 500 г", "Рыба", 789.00), ("Сельдь в масле 250 г", "Рыба", 159.00),
    ("Картофель 1 кг", "Овощи", 49.90), ("Морковь 1 кг", "Овощи", 54.90),
    ("Лук репчатый 1 кг", "Овощи", 44.90), ("Огурцы 1 кг", "Овощи", 189.00),
    ("Помидоры 1 кг", "Овощи", 249.00), ("Капуста 1 кг", "Овощи", 39.90),
    ("Яблоки 1 кг", "Фрукты", 139.00), ("Бананы 1 кг", "Фрукты", 129.00),
    ("Апельсины 1 кг", "Фрукты", 169.00), ("Мандарины 1 кг", "Фрукты", 219.00),
    ("Груши 1 кг", "Фрукты", 199.00), ("Виноград 1 кг", "Фрукты", 329.00),
    ("Вода 1,5 л", "Напитки", 49.00), ("Сок яблочный 1 л", "Напитки", 129.00),
    ("Лимонад 0,5 л", "Напитки", 79.00), ("Квас 1,5 л", "Напитки", 99.00),
    ("Минеральная вода 0,5 л", "Напитки", 69.00), ("Морс клюквенный 1 л", "Напитки", 139.00),
    ("Шоколад молочный 90 г", "Сладости", 109.00), ("Печенье овсяное 300 г", "Сладости", 99.00),
    ("Зефир 250 г", "Сладости", 149.00), ("Мороженое пломбир", "Сладости", 89.00),
    ("Конфеты ассорти 200 г", "Сладости", 349.00), ("Вафли 200 г", "Сладости", 79.00),
    ("Пельмени 800 г", "Заморозка", 389.00), ("Вареники 800 г", "Заморозка", 259.00),
    ("Пицца замороженная", "Заморозка", 299.00), ("Овощная смесь 400 г", "Заморозка", 149.00),
    ("Порошок стиральный 3 кг", "Бытовая химия", 699.00), ("Средство для посуды 500 мл", "Бытовая химия", 149.00),
    ("Туалетная бумага 8 рул.", "Бытовая химия", 299.00), ("Бумажные полотенца 2 рул.", "Бытовая химия", 129.00),
    ("Шампунь 400 мл", "Гигиена", 349.00), ("Зубная паста 100 мл", "Гигиена", 189.00),
    ("Мыло жидкое 300 мл", "Гигиена", 119.00), ("Подгузники 50 шт", "Гигиена", 1299.00),
    ("Корм для кошек 400 г", "Зоотовары", 189.00), ("Наполнитель 5 л", "Зоотовары", 349.00),
    ("Батарейки AA 4 шт", "Прочее", 249.00), ("Пакет-майка", "Прочее", 9.90),
    ("Йогурт питьевой 270 г", "Молочные", 69.90), ("Ряженка 4% 500 г", "Молочные", 84.90),
    ("Сырок глазированный", "Молочные", 49.90), ("Каша овсяная 500 г", "Бакалея", 89.90),
    ("Мёд цветочный 250 г", "Бакалея", 349.00), ("Орехи грецкие 150 г", "Бакалея", 299.00),
    ("Оливки 300 г", "Бакалея", 199.00), ("Кетчуп 350 г", "Бакалея", 119.00),
    ("Майонез 400 г", "Бакалея", 129.00), ("Горошек зелёный 400 г", "Бакалея", 99.00),
]
# 200 lines whose product (properly quoted) contains ';', 37 lines where it is NOT quoted (broken)
CSV_QUOTED_PRODUCT = 'Печенье "Юбилейное; традиционное" 112 г'
CSV_BROKEN_PRODUCT = 'Сок "Сады; мультифрукт" 1 л'
CSV_HEADER = ["Дата", "Время", "Магазин", "Номер чека", "Товар", "Категория", "Кол-во", "Цена", "Сумма", "Скидка", "Способ оплаты"]


def csv_rows(seed: int = 17, total: int = 120_000):
    """Yield (fields, raw_line, kind) for the CSV body; kind in ok|quoted|broken|return."""
    rnd = random.Random(seed)
    start = D(2025, 1, 1)
    lines = []
    receipt_no = 0
    quoted_left, broken_left, returns_left = 200, 37, 500
    i = 0
    while len(lines) < total:
        receipt_no += 1
        day = start + dt.timedelta(days=(len(lines) * 365) // total)
        shop = CSV_SHOPS[rnd.randrange(6)]
        hh, mm = 8 + rnd.randrange(14), rnd.randrange(60)
        pay = ["Карта", "Наличные", "СБП"][rnd.randrange(3)]
        n_items = 1 + rnd.randrange(6)
        is_return = returns_left > 0 and rnd.random() < 0.012
        for _ in range(n_items):
            if len(lines) >= total:
                break
            i += 1
            pidx = rnd.randrange(len(CSV_PRODUCTS))
            name, cat, price = CSV_PRODUCTS[pidx]
            kind = "ok"
            if quoted_left and i % 597 == 0:
                name, cat, price, kind = CSV_QUOTED_PRODUCT, "Сладости", 74.90, "quoted"
                quoted_left -= 1
            elif broken_left and i % 3203 == 0:
                name, cat, price, kind = CSV_BROKEN_PRODUCT, "Напитки", 119.00, "broken"
                broken_left -= 1
            qty = 1 + rnd.randrange(3)
            if is_return:
                qty, kind = -1, "return"
                returns_left -= 1
            disc = 0.0 if rnd.random() < 0.8 else round(price * qty * 0.1, 2) if qty > 0 else 0.0
            summ = round(price * qty - disc, 2)
            f = [day.strftime("%d.%m.%Y"), f"{hh:02d}:{mm:02d}", shop, f"{receipt_no:07d}", name, cat,
                 str(qty), f"{price:.2f}".replace(".", ","), f"{summ:.2f}".replace(".", ","),
                 f"{disc:.2f}".replace(".", ","), pay if qty > 0 else "Возврат"]
            if kind == "quoted":
                raw = ";".join(f[:4] + ['"' + name.replace('"', '""') + '"'] + f[5:])
            else:
                raw = ";".join(f)  # broken: ';' inside unquoted name → 12 fields
            lines.append((f, raw, kind))
            if is_return:
                break
    return lines


def csv_expected(seed: int = 17):
    rows = csv_rows(seed)

    def agg(include_broken: bool):
        rev_shop_month = defaultdict(float)
        rev_product = defaultdict(float)
        receipts = defaultdict(set)
        rev_shop = defaultdict(float)
        sales_shop = defaultdict(float)  # sale lines only: the gross average check does not net the returns
        sales_shop_month = defaultdict(float)
        ret_count = ret_sum = 0
        n = 0
        for f, _, kind in rows:
            if kind == "broken" and not include_broken:
                continue
            n += 1
            d = dt.datetime.strptime(f[0], "%d.%m.%Y").date()
            s = float(f[8].replace(",", "."))
            rev_shop_month[(f[2], d.month)] += s
            rev_product[f[4]] += s
            rev_shop[f[2]] += s
            if kind == "return":
                ret_count += 1
                ret_sum += s
            else:
                receipts[f[2]].add(f[3])
                sales_shop[f[2]] += s
                sales_shop_month[(f[2], d.month)] += s
        top = sorted(rev_product.items(), key=lambda kv: -kv[1])[:20]
        return dict(
            rows_used=n,
            revenue_net_total=round(sum(rev_shop.values()), 2),
            revenue_net_by_shop={k: round(v, 2) for k, v in sorted(rev_shop.items())},
            revenue_shop1_by_month={m: round(rev_shop_month[(CSV_SHOPS[0], m)], 2) for m in range(1, 13)},
            sales_shop1_by_month={m: round(sales_shop_month[(CSV_SHOPS[0], m)], 2) for m in range(1, 13)},
            top20_products=[(k, round(v, 2)) for k, v in top],
            avg_check_by_shop={k: round(rev_shop[k] / len(receipts[k]), 2) for k in sorted(rev_shop)},
            avg_check_gross_by_shop={k: round(sales_shop[k] / len(receipts[k]), 2) for k in sorted(sales_shop)},
            returns_lines=ret_count, returns_sum=round(ret_sum, 2),
        )

    kinds = Counter(k for _, _, k in rows)
    return dict(lines=len(rows), kinds=dict(kinds), repaired=agg(True), skipped_broken=agg(False))


# ---------------------------------------------------------------- f-schedule-to-ics

SCHEDULE = [
    ("Плавание", [0, 2], "17:00", "18:00", "Бассейн «Образец», ул. Примерная, 10"),
    ("Шахматы", [1], "16:00", "17:30", "ДДТ «Тест», ул. Тестовая, 3, каб. 12"),
    ("Английский", [3], "18:30", "19:30", "Языковой центр «Специмен», пр. Учебный, 7"),
    ("Английский", [5], "11:00", "12:00", "Языковой центр «Специмен», пр. Учебный, 7"),
    ("Футбол", [4], "17:30", "19:00", "Стадион «Юность-Образец», ул. Спортивная, 1"),
]
SCHED_START, SCHED_END = D(2026, 10, 15), D(2026, 12, 31)
SCHED_BREAK = (D(2026, 10, 26), D(2026, 11, 1))
SCHED_CANCEL = {D(2026, 11, 4), D(2026, 12, 31)}
SCHED_EXTRA = [("Плавание", D(2026, 11, 5), "17:00", "18:00", "Бассейн «Образец», ул. Примерная, 10")]


def schedule_occurrences():
    occ = []
    day = SCHED_START
    while day <= SCHED_END:
        if not (SCHED_BREAK[0] <= day <= SCHED_BREAK[1]) and day not in SCHED_CANCEL:
            for name, wds, s, e, loc in SCHEDULE:
                if day.weekday() in wds:
                    occ.append((name, day.isoformat(), s, e, loc))
        day += dt.timedelta(days=1)
    for name, d, s, e, loc in SCHED_EXTRA:
        occ.append((name, d.isoformat(), s, e, loc))
    occ.sort(key=lambda o: (o[1], o[2]))
    return occ


def schedule_expected():
    occ = schedule_occurrences()
    return dict(total=len(occ), by_activity=dict(Counter(o[0] for o in occ)),
                none_between=["2026-10-26", "2026-11-01"], moved="2026-11-05T17:00 Плавание",
                cancelled=["2026-11-04 Плавание", "2026-12-31 Английский"])


# ---------------------------------------------------------------- f-contacts-to-vcf

CONTACTS = [
    # name, phone1, phone2, email, note, bday, expected E.164 list (None = keep as typed + flag)
    ("Мама", "8 (916) 000-12-34", "", "", "", "12.05", ["+79160001234"]),
    ("мама", "+7 916 000 12 34", "8-495-000-11-22", "", "дом", "", ["+79160001234", "+74950001122"]),
    ("Петров Иван", "9160002233", "", "ivan.petrov@example.com", "работа", "03.11.1985", ["+79160002233"]),
    ("Иван Петров", "+7(916)000-22-33", "", "", "", "", ["+79160002233"]),
    ("Сантехник Олег", "8 903 000 44 55", "", "", "", "", ["+79030004455"]),
    ("Офис Образец", "8-495-000-00-01 доб. 123", "", "office@example.com", "", "", ["+74950000001;ext=123"]),
    ("Тётя Света Минск", "+375 29 000-00-00", "", "", "Беларусь", "21.07", ["+375290000000"]),
    ("Консьерж", "000-12-34", "", "", "городской", "", [None]),
    ("Ветеринар Анна", "8 (926) 000 77 88", "", "vet@example.com", "", "", ["+79260007788"]),
    ("Анна Ветеринар", "89260007788", "", "", "", "", ["+79260007788"]),
    ("Лёша Шахматы", "+7 977 000 33 21", "", "", "тренер Лёвы", "", ["+79770003321"]),
    ("Алексей тренер", "89770003321", "", "chess@example.com", "", "", ["+79770003321"]),
    ("Школа 1 Образец", "8(495)000-00-02", "", "school@example.com", "", "", ["+74950000002"]),
    ("Папа", "8 916 000 98 76", "", "", "", "30.01.1960", ["+79160009876"]),
    ("папа", "+79160009876", "", "", "", "", ["+79160009876"]),
]


def contacts_rows():
    """60 rows: the 15 above (5 duplicate pairs) plus 45 generated singletons (unique numbers)."""
    rows = list(CONTACTS)
    rnd = random.Random(19)
    first = ["Алексей", "Мария", "Дмитрий", "Ольга", "Сергей", "Наталья", "Андрей", "Екатерина",
             "Павел", "Юлия", "Никита", "Ксения", "Роман", "Алина", "Георгий", "Вера"]
    fmts = ["8 ({a}) {b}-{c}-{d}", "+7 {a} {b} {c} {d}", "8{a}{b}{c}{d}", "+7({a}){b}-{c}{d}", "{a} {b}{c}{d}"]
    for k in range(45):
        a = "9" + f"{rnd.randrange(10, 99)}"
        b, c, d = "000", f"{k:02d}", f"{rnd.randrange(10, 99)}"
        phone = fmts[k % 5].format(a=a, b=b, c=c, d=d)
        name = f"{first[k % 16]} ({['работа', 'двор', 'спорт', 'дача'][k % 4]} {k + 1})"
        rows.append((name, phone, "", "", "", "", [f"+7{a}{b}{c}{d}"]))
    return rows


def contacts_expected():
    rows = contacts_rows()
    return dict(rows=len(rows), duplicate_pairs=5, contacts_after_merge=len(rows) - 5,
                e164_planted={r[0]: r[6] for r in rows[:15]})


# ---------------------------------------------------------------- f-1c-bank-akt-sverki

US = dict(name="ИП Образцов Олег Олегович", inn="770000000012", acc="40802810000000000001",
          bank="АО «Банк Образец»", bik="044500000", corr="30101810000000000000")
THEM = dict(name="ООО «Тест-Поставка»", inn="7700000017", kpp="770001001", acc="40702810000000000002")
DECOY = dict(name="ООО «Тест-Поставка Плюс»", inn="7700000024", kpp="770001001", acc="40702810000000000003")
AKT_OPENING = 50_000.00
UPD = [("101", D(2026, 7, 3), 84_000.00), ("105", D(2026, 7, 17), 46_250.00),
       ("109", D(2026, 8, 5), 120_000.00), ("112", D(2026, 8, 19), 33_600.00),
       ("115", D(2026, 9, 2), 78_900.00), ("118", D(2026, 9, 21), 37_500.00)]
PAY_FROM_THEM = [(D(2026, 7, 8), "214", 50_000.00), (D(2026, 7, 25), "251", 84_000.00),
                 (D(2026, 8, 12), "287", 46_250.00), (D(2026, 8, 26), "305", 120_000.00),
                 (D(2026, 9, 15), "342", 33_600.00)]
PAY_FROM_DECOY = [(D(2026, 8, 10), "77", 15_000.00), (D(2026, 9, 11), "91", 22_000.00)]
OTHER_BANK_OPS = [  # outgoing / unrelated, to make the 1C file realistic
    (D(2026, 7, 10), "out", "ООО «Хостинг-Образец»", "7700000031", 4_800.00, "Оплата по счёту 15 за хостинг"),
    (D(2026, 7, 28), "out", "УФК по г. Москве (ИФНС)", "7700000048", 36_238.00, "Единый налоговый платёж"),
    (D(2026, 8, 3), "in", "ООО «Другой Клиент»", "7700000055", 64_000.00, "Оплата по счёту 98"),
    (D(2026, 8, 31), "out", "ИП Тестова А.А.", "770000000029", 12_000.00, "Оплата по договору субподряда"),
    (D(2026, 9, 10), "out", "АО «Банк Образец»", "7700000062", 1_490.00, "Комиссия за обслуживание счёта"),
    (D(2026, 9, 28), "in", "ООО «Другой Клиент»", "7700000055", 28_500.00, "Оплата по счёту 104"),
]
THEIR_ACT = dict(  # counterparty's version (mirrored: their credit = our debit)
    opening=50_000.00,
    purchases=[("101", D(2026, 7, 3), 84_000.00), ("105", D(2026, 7, 17), 46_250.00),
               ("109", D(2026, 8, 5), 120_000.00), ("112", D(2026, 8, 19), 33_600.00),
               ("115", D(2026, 9, 2), 78_900.00), ("118", D(2026, 9, 21), 35_700.00),
               ("118-К (УКД, возврат)", D(2026, 9, 28), -12_000.00)],
    payments=[(D(2026, 7, 8), "214", 50_000.00), (D(2026, 7, 25), "251", 84_000.00),
              (D(2026, 8, 12), "287", 46_250.00), (D(2026, 8, 26), "305", 120_000.00),
              (D(2026, 9, 15), "342", 33_600.00), (D(2026, 9, 29), "361", 78_900.00)],
)


def akt_expected():
    deb = sum(a for _, _, a in UPD)
    cred = sum(a for _, _, a in PAY_FROM_THEM)
    their_close = THEIR_ACT["opening"] + sum(a for *_, a in THEIR_ACT["purchases"]) - sum(a for *_, a in THEIR_ACT["payments"])
    ours = AKT_OPENING + deb - cred
    return dict(opening_debit=AKT_OPENING, turnover_debit=round(deb, 2), turnover_credit=round(cred, 2),
                closing_in_our_favour=round(ours, 2), their_closing=round(their_close, 2),
                difference=round(ours - their_close, 2),
                discrepancies=[
                    dict(what="платёж п/п 361 от 29.09.2026 есть у них, в нашей выписке за III кв. нет", amount=78_900.00),
                    dict(what="УПД 118 от 21.09.2026: у нас 37 500,00, у них 35 700,00", amount=1_800.00),
                    dict(what="УКД 118-К от 28.09.2026 −12 000,00 есть только у них", amount=12_000.00),
                ],
                decoy_payments_excluded=[a for *_, a in PAY_FROM_DECOY])


# ---------------------------------------------------------------- f-mortgage-schedule-prepay

def mortgage(principal=7_500_000.00, rate=0.06, n=360, first=D(2026, 11, 20),
             prepay=((8, 500_000.00, "term"), (14, 300_000.00, "payment"))):
    """Interest = round(balance*rate/12, 2); payment round to kopecks; prepayment applied
    right after the regular payment k. 'term' keeps the payment, 'payment' re-annuitises
    over the remaining count of the current schedule. Returns schedule rows."""
    r = rate / 12

    def annuity(b, m):  # rounded UP to the kopeck, so the last payment is the short one
        return math.ceil(round(b * r / (1 - (1 + r) ** -m) * 100, 6)) / 100

    def remaining(b, pay):  # payments left at payment `pay` (last one partial)
        k = 0
        while b > 0.005:
            k += 1
            b = round(b + round(b * r, 2) - pay, 2)
        return k

    pp = {k: (amt, mode) for k, amt, mode in prepay}
    bal, pay = principal, annuity(principal, n)
    rows, k = [], 0
    while bal > 0.005:
        k += 1
        y, m = divmod(first.month - 1 + k - 1, 12)
        date = D(first.year + y, m + 1, first.day)
        interest = round(bal * r, 2)
        this = pay if bal + interest > pay + 0.005 else round(bal + interest, 2)
        principal_part = round(this - interest, 2)
        bal = round(bal - principal_part, 2)
        extra = 0.0
        if k in pp and bal > 0:
            amt, mode = pp[k]
            left = remaining(bal, pay)  # payments left in the current schedule
            extra = min(amt, bal)
            bal = round(bal - extra, 2)
            if mode == "payment" and bal > 0:
                pay = annuity(bal, left)
        rows.append(dict(k=k, date=date.isoformat(), payment=this, interest=interest,
                         principal=principal_part, extra=extra, balance=bal))
    return rows


def mortgage_expected():
    base = mortgage(prepay=())
    withp = mortgage()
    i_base = round(sum(x["interest"] for x in base), 2)
    i_with = round(sum(x["interest"] for x in withp), 2)
    after_14 = withp[14]["payment"]  # payment #15
    return dict(
        annuity=base[0]["payment"], payments_without=len(base), last_date_without=base[-1]["date"],
        interest_without=i_base, payments_with=len(withp), last_date_with=withp[-1]["date"],
        interest_with=i_with, saving=round(i_base - i_with, 2), payment_after_dec2027=after_14,
        first_interest=withp[0]["interest"], balance_after_8=withp[7]["balance"],
        balance_after_14=withp[13]["balance"],
        annuity_if_rate_7=mortgage(rate=0.07, prepay=())[0]["payment"],
    )


# ---------------------------------------------------------------- small fixed cases

RECEIPTS = [  # f-receipts-expense-report; dup=index of receipt it duplicates
    dict(n=1, date="12.10.2026 07:40", seller="ООО «Такси-Образец»", inn="1650000001", total=1250.00, vat="без НДС", fd="10431", kind="e-receipt screenshot"),
    dict(n=2, date="12.10.2026 14:05", seller="ООО «Гостиница Образец»", inn="1655000002", total=9800.00, vat="НДС не облагается", fd="58712", kind="A4 hotel invoice-receipt photo"),
    dict(n=3, date="12.10.2026 20:31", seller="ООО «Кафе Специмен»", inn="1655000003", total=1140.00, vat="НДС 20%: 190,00", fd="22917", kind="thermal, rotated -8°"),
    dict(n=4, date="13.10.2026 09:12", seller="АО «Экспресс-Образец»", inn="1655000004", total=500.00, vat="НДС 20%: 83,33", fd="7741", kind="thermal, upside-down"),
    dict(n=5, dup=3, kind="same receipt as 3, other angle + flash glare"),
    dict(n=6, date="13.10.2026 16:48", seller="ООО «Канц-Тест»", inn="1655000006", total=780.50, vat="НДС 20%: 130,08", fd="33402", kind="thermal, crumpled, faded"),
    dict(n=7, date="14.10.2026 13:20", seller="ООО «Кафе Специмен»", inn="1655000003", total=2365.00, vat="НДС 20%: 394,17", fd="23188", kind="thermal, blurry but total readable"),
    dict(n=8, date="20.10.2026 18:02", seller="ООО «Одежда-Образец»", inn="7700000079", total=6990.00, vat="НДС 20%: 1165,00", fd="90155", kind="thermal, outside trip dates"),
]

GRAMOTY = [  # f-mailmerge-gramoty-dative: (nominative "Фамилия Имя", gender, dative)
    ("Иванов Пётр", "м", "Иванову Петру"), ("Смирнова Анна", "ж", "Смирновой Анне"),
    ("Черных Илья", "м", "Черных Илье"), ("Черных Дарья", "ж", "Черных Дарье"),
    ("Ким Алина", "ж", "Ким Алине"), ("Ким Тимур", "м", "Киму Тимуру"),
    ("Грицук Мария", "ж", "Грицук Марии"), ("Шевчук Никита", "м", "Шевчуку Никите"),
    ("Кузьмина Любовь", "ж", "Кузьминой Любови"), ("Лебедь Павел", "м", "Лебедю Павлу"),
    ("Гурамишвили Нино", "ж", "Гурамишвили Нино"), ("Соловей Лев", "м", "Соловью Льву"),
    ("Белых Ксения", "ж", "Белых Ксении"), ("Ткаченко Артём", "м", "Ткаченко Артёму"),
    ("Ткаченко Илья", "м", "Ткаченко Илье"), ("Рябой Михаил", "м", "Рябому Михаилу"),
    ("Толстая Варвара", "ж", "Толстой Варваре"), ("Кох Ева", "ж", "Кох Еве"),
    ("Никитин Савва", "м", "Никитину Савве"), ("Пушкарь Глеб", "м", "Пушкарю Глебу"),
    ("Ли Даниил", "м", "Ли Даниилу"), ("Ворона Ангелина", "ж", "Вороне Ангелине"),
    ("Мороз Ярослава", "ж", "Мороз Ярославе"), ("Мороз Ярослав", "м", "Морозу Ярославу"),
    ("Голубь Николь", "ж", "Голубь Николь"),
]

OCR_ACT_ROWS = [  # f-ocr-act-table-docx; row 4 sum deliberately != qty*price (as printed)
    (1, "Разработка макета сайта", "усл.", "1", "45 000,00", "45 000,00"),
    (2, "Вёрстка страниц", "стр.", "12", "3 500,00", "42 000,00"),
    (3, "Настройка CMS", "усл.", "1", "18 000,00", "18 000,00"),
    (4, "Наполнение каталога", "позиция", "150", "120,00", "18 600,00"),
    (5, "Интеграция платёжного модуля", "усл.", "1", "25 000,00", "25 000,00"),
    (6, "Копирайтинг", "1000 зн.", "25", "650,00", "16 250,00"),
    (7, "Техническая поддержка (октябрь)", "час", "30", "670,00", "20 100,00"),
]
OCR_ACT_TOTAL = "184 950,00"


def all_expected():
    return dict(
        sales=sales_expected(), bank=bank_expected(), csv=csv_expected(), schedule=schedule_expected(),
        contacts=contacts_expected(), akt=akt_expected(), mortgage=mortgage_expected(),
        receipts_total=round(sum(r["total"] for r in RECEIPTS if "total" in r and r["n"] != 8), 2),
        ndfl=dict(treatment=180_000, child_edu=60_000, social_limit=150_000, child_limit=110_000,
                  deduction=150_000 + 60_000, refund=round((150_000 + 60_000) * 0.13, 2)),
    )


if __name__ == "__main__":
    print(json.dumps(all_expected(), ensure_ascii=False, indent=1, default=str))
