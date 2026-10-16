"""Fixtures for f-invoice-act-qr (ИП on УСН issues an invoice with a ГОСТ Р 56042 QR and an act).

rekvizity_IP.pdf — requisites card «Карточка индивидуального предпринимателя» of the fictional
  ИП Образцова Елена Сергеевна: ИНН 770000000143, ОГРНИП 300000000000000, р/с 40802810000000000001,
  АО «Банк Образец», БИК 044500000, к/с 30101810000000000000, address, e-mail elena@example.com,
  tax regime УСН without VAT. There is deliberately no «КПП» anywhere (an ИП has none; the case checks
  that the invoice mentions КПП only for the buyer).
logo.png — 512×512 RGBA with a transparent background: round monogram «ЕО» and the word «ОБРАЗЕЦ».

truth/rekvizity_IP.json — the requisites, the services from the chat, amount in words and the expected
ГОСТ Р 56042 payload fields (Sum in kopecks) that the qr_decode check looks for.
"""

from __future__ import annotations

import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402

CASE = "f-invoice-act-qr"
W, H = C.FF_A4

IP = dict(
    full_name="Индивидуальный предприниматель Образцова Елена Сергеевна",
    short_name="ИП Образцова Е. С.",
    fio="Образцова Елена Сергеевна",
    inn="770000000143",
    ogrnip="300000000000000",
    reg_date="12.03.2023",
    address="125000, г. Москва, ул. Примерная, д. 12, кв. 34",
    acc="40802810000000000001",
    bank="АО «Банк Образец»",
    bank_city="г. Москва",
    bik="044500000",
    corr="30101810000000000000",
    phone="+7 (900) 000-00-00",
    email="elena@example.com",
    okved="74.10 — Деятельность специализированная в области дизайна",
    tax="УСН «Доходы», НДС не облагается (п. 2 ст. 346.11 НК РФ)",
)
BUYER = dict(name="ООО «Ромашка-Образец»", inn="7700000125", kpp="770001001", address="г. Москва, ул. Тестовая, д. 7")
SERVICES = [("Разработка логотипа", 18_000.00), ("Фирменный стиль", 6_500.00)]
TOTAL = 24_500.00


def build_card(path: pathlib.Path) -> None:
    C.ff_register_rl_fonts("LiberationSans", "LiberationSans-Bold")
    c = C.ff_rl_canvas(str(path), title="Реквизиты ИП Образцова Е. С. (ОБРАЗЕЦ)",
                       subject="Карточка индивидуального предпринимателя — ОБРАЗЕЦ, вымышленные данные")
    c.setFillColorRGB(0.78, 0.1, 0.1)
    c.setFont("LiberationSans-Bold", 9)
    c.drawRightString(W - 28, H - 22, "ОБРАЗЕЦ / SPECIMEN — вымышленные данные")
    C.bk_rl_watermark(c, cx=W / 2, cy=300, size=58, angle=30, alpha=0.10)

    # coloured top band like a typical requisites card
    c.setFillColorRGB(0.11, 0.44, 0.47)
    c.rect(40, H - 92, W - 80, 46, stroke=0, fill=1)
    c.setFillColorRGB(1, 1, 1)
    c.setFont("LiberationSans-Bold", 15)
    c.drawString(56, H - 68, "Карточка индивидуального предпринимателя")
    c.setFont("LiberationSans", 9.5)
    c.drawString(56, H - 84, "Реквизиты для договоров, счетов и актов")

    rows = [
        ("Полное наименование", IP["full_name"]),
        ("Сокращённое наименование", IP["short_name"]),
        ("ИНН", IP["inn"]),
        ("ОГРНИП", f"{IP['ogrnip']} (дата регистрации {IP['reg_date']})"),
        ("Адрес регистрации", IP["address"]),
        ("Система налогообложения", IP["tax"]),
        ("Основной ОКВЭД", IP["okved"]),
        ("Расчётный счёт", IP["acc"]),
        ("Банк", f"{IP['bank']}, {IP['bank_city']}"),
        ("БИК", IP["bik"]),
        ("Корреспондентский счёт", IP["corr"]),
        ("Телефон", IP["phone"]),
        ("E-mail", IP["email"]),
    ]
    c.setFillColorRGB(0, 0, 0)
    x0, split, x1 = 40, 210, W - 40
    y = H - 112
    c.setStrokeColorRGB(0.7, 0.7, 0.7)
    c.setLineWidth(0.6)
    for i, (label, value) in enumerate(rows):
        h = 24
        if i % 2 == 0:
            c.setFillColorRGB(0.95, 0.97, 0.97)
            c.rect(x0, y - h, x1 - x0, h, stroke=0, fill=1)
        c.setFillColorRGB(0.25, 0.25, 0.25)
        c.setFont("LiberationSans", 9.5)
        c.drawString(x0 + 8, y - 15.5, label)
        c.setFillColorRGB(0, 0, 0)
        c.setFont("LiberationSans-Bold", 10)
        c.drawString(split + 8, y - 15.5, value)
        c.line(x0, y - h, x1, y - h)
        y -= h
    c.line(split, H - 112, split, y)
    c.rect(x0, y, x1 - x0, H - 112 - y, stroke=1, fill=0)

    c.setFont("LiberationSans", 9.5)
    c.drawString(40, y - 30, "Индивидуальный предприниматель")
    c.line(220, y - 32, 330, y - 32)
    c.drawString(340, y - 30, "Е. С. Образцова")
    C.bk_rl_signature(c, 226, y - 36, 96, 22, seed=143)
    c.setFont("LiberationSans", 7)
    c.setFillColorRGB(0.35, 0.35, 0.35)
    c.drawString(40, 30, "Все реквизиты вымышлены и не принадлежат реальным лицам и банкам. ОБРАЗЕЦ / SPECIMEN.")
    c.showPage()
    c.save()


def build_logo(path: pathlib.Path) -> None:
    from PIL import Image, ImageDraw

    S = 4  # supersample
    N = 512 * S
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    teal = (28, 112, 120, 255)
    coral = (232, 106, 84, 255)
    cx, cy, r = N // 2, int(N * 0.43), int(N * 0.36)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=teal)
    d.ellipse([cx - int(r * 0.86), cy - int(r * 0.86), cx + int(r * 0.86), cy + int(r * 0.86)],
              outline=(255, 255, 255, 255), width=5 * S)
    f = C.ff_pil_font("DejaVuSerif-Bold", int(r * 0.74))
    d.text((cx - int(r * 0.03), cy + int(r * 0.04)), "ЕО", font=f, fill=(255, 255, 255, 255), anchor="mm")
    # small accent dot
    d.ellipse([cx + int(r * 0.62), cy - int(r * 0.78), cx + int(r * 0.86), cy - int(r * 0.54)], fill=coral)
    f2 = C.ff_pil_font("DejaVuSans-Bold", int(N * 0.085))
    d.text((cx, int(N * 0.885)), "ОБРАЗЕЦ", font=f2, fill=coral, anchor="mm")
    f3 = C.ff_pil_font("DejaVuSans", int(N * 0.04))
    d.text((cx, int(N * 0.955)), "SPECIMEN", font=f3, fill=(28, 112, 120, 200), anchor="mm")
    img = img.resize((512, 512), Image.LANCZOS)
    C.px_save_png_deterministic(img, path)


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    p_card = out_dir / "rekvizity_IP.pdf"
    p_logo = out_dir / "logo.png"
    build_card(p_card)
    build_logo(p_logo)
    truth = dict(
        case=CASE,
        seller=IP,
        seller_has_kpp=False,
        buyer=BUYER,
        services=[dict(name=n, qty=1, unit="усл.", price=p, sum=p) for n, p in SERVICES],
        total=TOTAL,
        total_words=C.bk_rub_words(TOTAL),
        vat="Без НДС (УСН)",
        qr_expected=dict(
            header_any=["ST00012", "ST00011"],
            fields=dict(Name=f"ИП {IP['fio']}", PersonalAcc=IP["acc"], BankName=IP["bank"], BIC=IP["bik"],
                        CorrespAcc=IP["corr"], PayeeINN=IP["inn"], Sum=str(int(round(TOTAL * 100))),
                        Purpose="Оплата по счёту № … от … за разработку логотипа и фирменного стиля. Без НДС"),
            example=("ST00012|Name=ИП Образцова Елена Сергеевна|PersonalAcc=40802810000000000001|"
                     "BankName=АО «Банк Образец»|BIC=044500000|CorrespAcc=30101810000000000000|"
                     "PayeeINN=770000000143|Sum=2450000|Purpose=Оплата по счёту № 1 от <дата>. Без НДС"),
        ),
        logo=dict(file="logo.png", size=[512, 512], mode="RGBA", transparent_background=True),
    )
    tpath = C.ff_write_json(truth_dir / "rekvizity_IP.json", truth)
    return [str(p_card), str(p_logo), tpath]


if __name__ == "__main__":
    base = HERE.parent
    for p in build(base / "out" / CASE, base / "truth"):
        print(p)
