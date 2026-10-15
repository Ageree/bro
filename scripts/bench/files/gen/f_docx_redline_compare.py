"""Fixture for f-docx-redline-compare.

dogovor_uslug_v1_nash.docx    «ДОГОВОР ВОЗМЕЗДНОГО ОКАЗАНИЯ УСЛУГ № 15/26 (ОБРАЗЕЦ)», ~3 pages A4, 9 sections with
                              manual numbering «1.», «1.1.», 48 body paragraphs (no tables, no empty paragraphs),
                              one run per paragraph; header «ОБРАЗЕЦ / SPECIMEN».
dogovor_uslug_v2_ot_nih.docx  the same document re-saved by the counterparty with track changes off:
                              C1 3.2 «10 (десяти) рабочих» → «30 (тридцати) рабочих»; C2 5.2 → asymmetric penalties
                              (Исполнитель 0,5 % without cap, Заказчик 0,1 % capped 10 %); C3 5.4 (liability cap)
                              deleted; C4 8.2 «города Москвы» → «Новосибирской области»; C5 4.1 deemed-acceptance
                              sentence deleted; cosmetic: typos fixed in 1.2 («услуг ,» → «услуг,») and 2.3
                              («в течении» → «в течение»), 2.1 made bold without text change.
                              The other 40 paragraphs are byte-identical XML (w:p) in both files.

truth/dogovor_uslug_15_26.json  every paragraph of v1/v2 with its category (identical / substantive C1–C5 /
                                typo / format), the check pairs and the minimal word-level diff of each change.

Paragraph count: the recipe says «46 абзацев» and «остальные 40 абзацев побайтно те же», but 5 substantive
changes + 2 typo paragraphs + 1 bold paragraph = 8 touched paragraphs, so 46 would leave 38 identical ones.
The checks («≥ 38 из 40» unchanged) are built on 40, so the document has 48 paragraphs (see issues/).
"""

from __future__ import annotations

import difflib
import pathlib
import sys

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.shared import Cm, Pt

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402

CASE = "f-docx-redline-compare"
V1_NAME = "dogovor_uslug_v1_nash.docx"
V2_NAME = "dogovor_uslug_v2_ot_nih.docx"
WHEN_V1 = (2026, 9, 1, 12, 0, 0)
WHEN_V2 = (2026, 10, 9, 17, 25, 0)

TITLE = "ДОГОВОР ВОЗМЕЗДНОГО ОКАЗАНИЯ УСЛУГ № 15/26 (ОБРАЗЕЦ)"
PLACE_DATE = ("г. Москва", "01 сентября 2026 г.")
PREAMBLE = (
    "Общество с ограниченной ответственностью «Образец Технологии» (ООО «Образец Технологии»), именуемое в "
    "дальнейшем «Исполнитель», в лице генерального директора Образцова Олега Олеговича, действующего на основании "
    "Устава, с одной стороны, и Общество с ограниченной ответственностью «Тест-Клиент» (ООО «Тест-Клиент»), "
    "именуемое в дальнейшем «Заказчик», в лице генерального директора Тестова Антона Андреевича, действующего на "
    "основании Устава, с другой стороны, совместно именуемые «Стороны», заключили настоящий Договор о нижеследующем:"
)

# (kind, key, v1 text, v2 text or None if deleted, category, change id)
# kind: "h" = section heading, "c" = clause, "sig" = signature block line
SECTIONS = [
    ("1. ПРЕДМЕТ ДОГОВОРА", [
        ("1.1.", "Исполнитель обязуется по заданию Заказчика оказать услуги по сопровождению и доработке "
                 "информационной системы Заказчика (далее — услуги), а Заказчик обязуется принять и оплатить эти "
                 "услуги в порядке и на условиях настоящего Договора."),
        ("1.2.", "Перечень, объём и сроки оказания услуг , а также требования к их результату согласовываются "
                 "Сторонами в заявках, которые являются неотъемлемой частью Договора."),
        ("1.3.", "Услуги оказываются дистанционно, а при необходимости — по месту нахождения Заказчика по адресу, "
                 "указанному в заявке."),
    ]),
    ("2. ПРАВА И ОБЯЗАННОСТИ СТОРОН", [
        ("2.1.", "Исполнитель обязан оказывать услуги качественно, в сроки, согласованные в заявках, и в "
                 "соответствии с требованиями действующего законодательства Российской Федерации."),
        ("2.2.", "Исполнитель вправе привлекать к оказанию услуг третьих лиц, оставаясь ответственным перед "
                 "Заказчиком за их действия."),
        ("2.3.", "Исполнитель обязан в течении 3 (трёх) рабочих дней сообщать Заказчику об обстоятельствах, которые "
                 "препятствуют оказанию услуг или влияют на их сроки."),
        ("2.4.", "Заказчик обязан своевременно предоставлять Исполнителю информацию, доступы и материалы, "
                 "необходимые для оказания услуг."),
        ("2.5.", "Заказчик вправе в любое время проверять ход оказания услуг, не вмешиваясь в оперативную "
                 "деятельность Исполнителя."),
    ]),
    ("3. СТОИМОСТЬ УСЛУГ И ПОРЯДОК РАСЧЁТОВ", [
        ("3.1.", "Стоимость услуг определяется в заявках исходя из ставки 3 500 (три тысячи пятьсот) рублей за один "
                 "час работы специалиста. НДС не облагается в связи с применением Исполнителем упрощённой системы "
                 "налогообложения."),
        ("3.2.", "Заказчик оплачивает услуги в течение 10 (десяти) рабочих дней с даты подписания Акта "
                 "сдачи-приёмки оказанных услуг (далее — Акт) на основании счёта Исполнителя."),
        ("3.3.", "Оплата производится в безналичном порядке путём перечисления денежных средств на расчётный счёт "
                 "Исполнителя. Обязательство Заказчика по оплате считается исполненным с даты списания денежных "
                 "средств с его счёта."),
        ("3.4.", "Стоимость услуг может быть изменена по соглашению Сторон не чаще одного раза в календарный год "
                 "с письменным уведомлением не менее чем за 30 (тридцать) календарных дней."),
    ]),
    ("4. ПОРЯДОК СДАЧИ-ПРИЁМКИ УСЛУГ", [
        ("4.1.", "По окончании оказания услуг по заявке Исполнитель направляет Заказчику Акт в двух экземплярах. "
                 "Заказчик подписывает Акт в течение 5 (пяти) рабочих дней или направляет мотивированный отказ. "
                 "При отсутствии ответа в указанный срок услуги считаются принятыми."),
        ("4.2.", "При наличии мотивированного отказа Стороны составляют перечень необходимых доработок и сроки их "
                 "выполнения. Доработки, вызванные недостатками услуг, выполняются Исполнителем за свой счёт."),
        ("4.3.", "Акт может быть подписан Сторонами в электронном виде с использованием системы электронного "
                 "документооборота."),
    ]),
    ("5. ОТВЕТСТВЕННОСТЬ СТОРОН", [
        ("5.1.", "За неисполнение или ненадлежащее исполнение обязательств по Договору Стороны несут "
                 "ответственность в соответствии с законодательством Российской Федерации."),
        ("5.2.", "За просрочку обязательств сторона уплачивает пени 0,1 % от суммы просроченного обязательства за "
                 "каждый день, но не более 10 %."),
        ("5.3.", "Уплата неустойки не освобождает Стороны от исполнения обязательств по Договору."),
        ("5.4.", "Совокупная ответственность Исполнителя ограничена суммой, уплаченной по Договору за последние "
                 "3 (три) месяца."),
    ]),
    ("6. КОНФИДЕНЦИАЛЬНОСТЬ", [
        ("6.1.", "Стороны обязуются не разглашать сведения, ставшие им известными в связи с исполнением Договора, "
                 "без письменного согласия другой Стороны."),
        ("6.2.", "Обязательства по сохранению конфиденциальности действуют в течение срока действия Договора и "
                 "3 (трёх) лет после его прекращения."),
        ("6.3.", "Не является нарушением раскрытие сведений по требованию государственных органов в случаях, "
                 "предусмотренных законом."),
    ]),
    ("7. ОБСТОЯТЕЛЬСТВА НЕПРЕОДОЛИМОЙ СИЛЫ", [
        ("7.1.", "Стороны освобождаются от ответственности за неисполнение обязательств, если оно вызвано "
                 "обстоятельствами непреодолимой силы."),
        ("7.2.", "Сторона, для которой исполнение стало невозможным, уведомляет другую Сторону в течение 5 (пяти) "
                 "рабочих дней с момента возникновения таких обстоятельств."),
        ("7.3.", "Если обстоятельства непреодолимой силы действуют более 2 (двух) месяцев, каждая из Сторон вправе "
                 "отказаться от Договора без возмещения убытков."),
    ]),
    ("8. ПОРЯДОК РАЗРЕШЕНИЯ СПОРОВ", [
        ("8.1.", "Споры разрешаются путём переговоров. Претензионный порядок обязателен, срок ответа на претензию — "
                 "10 (десять) рабочих дней с даты её получения."),
        ("8.2.", "При недостижении согласия спор подлежит рассмотрению в Арбитражном суде города Москвы."),
        ("8.3.", "К отношениям Сторон, не урегулированным Договором, применяется законодательство Российской "
                 "Федерации."),
    ]),
    ("9. ЗАКЛЮЧИТЕЛЬНЫЕ ПОЛОЖЕНИЯ", [
        ("9.1.", "Договор вступает в силу с даты подписания и действует до 31 декабря 2026 года. Если ни одна из "
                 "Сторон за 30 (тридцать) календарных дней до окончания срока не заявит о его прекращении, Договор "
                 "считается продлённым на каждый следующий календарный год."),
        ("9.2.", "Каждая из Сторон вправе отказаться от Договора, письменно уведомив другую Сторону не менее чем за "
                 "30 (тридцать) календарных дней, при условии оплаты фактически оказанных услуг."),
        ("9.3.", "Изменения и дополнения к Договору действительны, если они совершены в письменной форме и подписаны "
                 "уполномоченными представителями Сторон."),
        ("9.4.", "Документы, переданные по электронной почте с адресов, указанных в реквизитах Сторон, имеют силу "
                 "до обмена оригиналами."),
        ("9.5.", "Договор составлен в двух экземплярах, имеющих одинаковую юридическую силу, по одному для каждой "
                 "из Сторон."),
    ]),
]
SIG_HEAD = "АДРЕСА, РЕКВИЗИТЫ И ПОДПИСИ СТОРОН"
SIGS = [
    "Исполнитель: ООО «Образец Технологии», ИНН 7700000093, КПП 770001001, 101000, г. Москва, ул. Образцовая, "
    "д. 1, р/с 40702810000000000093 в АО «Банк Образец», БИК 044500000, e-mail: info@obrazec-tech.example. "
    "Генеральный директор _______________ / О. О. Образцов /",
    "Заказчик: ООО «Тест-Клиент», ИНН 7700000100, КПП 770001001, 101000, г. Москва, ул. Тестовая, д. 2, "
    "р/с 40702810000000000100 в АО «Банк Специмен», БИК 044500001, e-mail: office@test-client.example. "
    "Генеральный директор _______________ / А. А. Тестов /",
]

# v2 edits keyed by clause number: (new text or None = paragraph deleted, category, change id)
V2_EDITS = {
    "3.2.": ("Заказчик оплачивает услуги в течение 30 (тридцати) рабочих дней с даты подписания Акта "
             "сдачи-приёмки оказанных услуг (далее — Акт) на основании счёта Исполнителя.", "substantive", "C1"),
    "5.2.": ("За просрочку Исполнитель уплачивает пени 0,5 % от суммы просроченного обязательства за каждый день. "
             "За просрочку Заказчик уплачивает пени 0,1 % от суммы просроченного обязательства за каждый день, "
             "но не более 10 %.", "substantive", "C2"),
    "5.4.": (None, "substantive", "C3"),
    "8.2.": ("При недостижении согласия спор подлежит рассмотрению в Арбитражном суде Новосибирской области.",
             "substantive", "C4"),
    "4.1.": ("По окончании оказания услуг по заявке Исполнитель направляет Заказчику Акт в двух экземплярах. "
             "Заказчик подписывает Акт в течение 5 (пяти) рабочих дней или направляет мотивированный отказ.",
             "substantive", "C5"),
    "1.2.": ("Перечень, объём и сроки оказания услуг, а также требования к их результату согласовываются "
             "Сторонами в заявках, которые являются неотъемлемой частью Договора.", "typo", "T1"),
    "2.3.": ("Исполнитель обязан в течение 3 (трёх) рабочих дней сообщать Заказчику об обстоятельствах, которые "
             "препятствуют оказанию услуг или влияют на их сроки.", "typo", "T2"),
}
V2_BOLD = {"2.1."}          # format-only change (F1)

CHANGE_NOTES = {
    "C1": "срок оплаты 10 → 30 рабочих дней (отсрочка платежа Исполнителю)",
    "C2": "пени стали асимметричными: Исполнитель 0,5 % в день без потолка, Заказчик 0,1 % с потолком 10 %",
    "C3": "удалён лимит совокупной ответственности Исполнителя (5.4)",
    "C4": "подсудность: Арбитражный суд города Москвы → Арбитражный суд Новосибирской области",
    "C5": "удалена «молчаливая приёмка» (услуги больше не считаются принятыми при молчании Заказчика)",
    "T1": "опечатка: лишний пробел перед запятой «услуг ,» → «услуг,»",
    "T2": "опечатка: «в течении» → «в течение»",
    "F1": "абзац 2.1 сделан полужирным, текст не менялся",
}


def _paragraph_list(version: int):
    """[(key, kind, text, bold)] in document order for v1 or v2."""
    items = [("title", "title", TITLE, True), ("place", "place", None, False), ("preamble", "preamble", PREAMBLE, False)]
    for head, clauses in SECTIONS:
        items.append((head.split(" ", 1)[0], "heading", head, True))
        for num, text in clauses:
            bold = False
            if version == 2 and num in V2_EDITS:
                new, _cat, _cid = V2_EDITS[num]
                if new is None:
                    continue
                text = new
            if version == 2 and num in V2_BOLD:
                bold = True
            items.append((num, "clause", f"{num} {text}", bold))
    items.append(("sig_head", "heading", SIG_HEAD, True))
    for i, s in enumerate(SIGS, start=1):
        items.append((f"sig{i}", "signature", s, False))
    return items


def _build(version: int, path: pathlib.Path):
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
    sec.left_margin, sec.right_margin = Cm(2.5), Cm(1.5)
    sec.top_margin, sec.bottom_margin = Cm(2.0), Cm(2.0)
    sec.header_distance = Cm(1.0)
    C.od_docx_base_style(doc, font="Times New Roman", size_pt=12, space_after_pt=6)
    C.od_docx_specimen_header(sec)

    for key, kind, text, bold in _paragraph_list(version):
        p = doc.add_paragraph()
        pf = p.paragraph_format
        if kind == "title":
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            pf.space_after = Pt(12)
            r = p.add_run(text)
            r.bold = True
            r.font.size = Pt(13)
        elif kind == "place":
            pf.tab_stops.add_tab_stop(Cm(17.0), WD_TAB_ALIGNMENT.RIGHT)
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            pf.space_after = Pt(12)
            p.add_run(f"{PLACE_DATE[0]}\t{PLACE_DATE[1]}")
        elif kind == "heading":
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            pf.space_before = Pt(6)
            pf.keep_with_next = True
            r = p.add_run(text)
            r.bold = True
        elif kind == "preamble":
            pf.first_line_indent = Cm(1.25)
            p.add_run(text)
        elif kind == "clause":
            pf.first_line_indent = Cm(1.25)
            r = p.add_run(text)
            if bold:
                r.bold = True
        elif kind == "signature":
            pf.space_before = Pt(6)
            p.add_run(text)
    C.docx_save_deterministic(doc, path, when=WHEN_V1 if version == 1 else WHEN_V2,
                              author="ОБРАЗЕЦ" if version == 1 else "ООО «Тест-Клиент» (ОБРАЗЕЦ)")
    C.ooxml_fix_core_dates(path, when=WHEN_V1 if version == 1 else WHEN_V2)


def _word_diff(a: str, b: str):
    """Minimal word-level diff (difflib on whitespace tokens) — what a sensible redline shows."""
    ta, tb = a.split(" "), b.split(" ")
    ops = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=ta, b=tb, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        ops.append({"op": tag, "del": " ".join(ta[i1:i2]) or None, "ins": " ".join(tb[j1:j2]) or None})
    return ops


def _paragraph_xml(path: pathlib.Path):
    import zipfile

    from lxml import etree

    with zipfile.ZipFile(path) as z:
        root = etree.fromstring(z.read("word/document.xml"))
    ns = {"w": C.OD_W_NS}
    return [etree.tostring(p) for p in root.findall("w:body/w:p", ns)]


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    v1, v2 = out_dir / V1_NAME, out_dir / V2_NAME
    _build(1, v1)
    _build(2, v2)

    # ---- truth: paragraph map v1 → v2 and byte-identity of untouched w:p
    p1, p2 = _paragraph_list(1), _paragraph_list(2)
    x1, x2 = _paragraph_xml(v1), _paragraph_xml(v2)
    assert len(p1) == len(x1) == 48 and len(p2) == len(x2) == 47, (len(p1), len(x1), len(p2), len(x2))
    idx2 = {k: i for i, (k, *_r) in enumerate(p2)}
    paragraphs, identical, changes = [], [], []
    for i, (key, kind, text, _bold) in enumerate(p1):
        j = idx2.get(key)
        t1 = text if text is not None else f"{PLACE_DATE[0]}\t{PLACE_DATE[1]}"
        t2 = None if j is None else (p2[j][2] if p2[j][2] is not None else t1)
        edit = V2_EDITS.get(key)
        cat = edit[1] if edit else ("format" if key in V2_BOLD else "identical")
        cid = edit[2] if edit else ("F1" if key in V2_BOLD else None)
        same_xml = j is not None and x1[i] == x2[j]
        if cat == "identical":
            assert same_xml, key
            identical.append(i)
        else:
            assert not same_xml, key
        row = {"v1_index": i, "v2_index": j, "key": key, "kind": kind, "category": cat, "change": cid,
               "v1_text": t1, "v2_text": t2, "xml_identical": same_xml}
        paragraphs.append(row)
        if cid:
            changes.append({"id": cid, "clause": key, "category": cat, "note": CHANGE_NOTES[cid],
                            "v1_text": t1, "v2_text": t2,
                            "word_diff": _word_diff(t1, t2) if t2 is not None else [{"op": "delete_paragraph",
                                                                                    "del": t1, "ins": None}]})
    assert len(identical) == 40, len(identical)
    text_v1 = "\n".join(r["v1_text"] for r in paragraphs)
    text_v2 = "\n".join(r["v2_text"] for r in paragraphs if r["v2_text"] is not None)

    truth = {
        "case": CASE,
        "files": {"v1": V1_NAME, "v2": V2_NAME},
        "paragraph_counts": {"v1": len(p1), "v2": len(p2), "identical_xml": len(identical),
                             "substantive": 5, "typo": 2, "format_only": 1},
        "identical_v1_indices": identical,
        "changes": changes,
        "paragraphs": paragraphs,
        "text_similarity_v1_v2": round(difflib.SequenceMatcher(a=text_v1, b=text_v2, autojunk=False).ratio(), 4),
        "risk_for_executor": {
            "unfavourable": ["C1", "C2", "C3", "C4", "C5"],
            "cosmetic": ["T1", "T2", "F1"],
        },
        "notes": [
            "Body paragraphs only (w:body/w:p); the document has no tables. Header «ОБРАЗЕЦ / SPECIMEN» is identical.",
            "Minimal word diff of C2 keeps «0,1 %» as unchanged text (it survives as the Заказчик rate): "
            "a correct minimal redline has «0,1 %» outside w:del. See issues/f-docx-redline-compare.md.",
        ],
    }
    tp = truth_dir / "dogovor_uslug_15_26.json"
    C.ff_write_json(tp, truth)
    return [str(v1), str(v2), str(tp)]


if __name__ == "__main__":
    root = HERE.parent
    for p in build(root / "out" / CASE, root / "truth"):
        print(p)
