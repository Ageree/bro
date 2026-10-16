"""Fixture for f-pdf-password-extract: buklet_ZhK.pdf — a developer's booklet encrypted with AES-256.

6 pages A4 landscape about the fictional «ЖК Образцовый» (text layer in DejaVu, embedded with ToUnicode) and
5 photo-like renders drawn with numpy/Pillow (sky gradient, rectangle houses with window grids, trees, a large
«SPECIMEN» label, sensor-like noise) of 3000×2000, 2400×1600, 1600×1600, 2000×3000 and 1200×800 px, each saved
as a baseline JPEG q=90 and embedded as a DCT pass-through image (pdfimages -j gives the very same bytes). The
images are drawn at 25–40 % (pt per px) except the portrait 2000×3000 one: at 25 % it would be 750 pt tall and
A4 landscape is 595 pt, so it is drawn at 18 % (see issues/f-pdf-password-extract.md). Page 6 has no image.

Encryption (generator only, needs `cryptography`): pypdf.encrypt(user_password='Kvartira-2026',
owner_password='owner-SPECIMEN-77', algorithm='AES-256') → /V 5 /R 6. pypdf draws the file key, salts and
per-object IVs from secrets.token_bytes; the generator swaps it for a seeded SHA-256 stream while encrypting so
the bytes are stable across runs.

truth/buklet_images/photo_<i>_<w>x<h>.jpg   the original JPEG files (bytes = what pdfimages -j must return)
truth/buklet_ZhK.json                       sha256, size, page, placement of each image; password data; page
                                            texts (pdftotext of the decrypted file) for the text-ratio check
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import math
import pathlib
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402

FIXTURE = "buklet_ZhK.pdf"
USER_PW = "Kvartira-2026"
OWNER_PW = "owner-SPECIMEN-77"
JPEG_Q = 90
PAGE = (C.FF_A4[1], C.FF_A4[0])          # A4 landscape, 841.89 × 595.28 pt
SEED = 77_2026

# (index, size px, scene, page, scale pt/px, x, y in pt)
PHOTOS = [
    (1, (3000, 2000), "panorama", 1, 0.25, 46.0, 30.0),
    (2, (2400, 1600), "courtyard", 2, 0.25, 215.0, 60.0),
    (3, (1600, 1600), "park", 3, 0.30, 330.0, 60.0),
    (4, (2000, 3000), "tower", 4, 0.18, 440.0, 25.0),
    (5, (1200, 800), "sunset", 5, 0.40, 330.0, 200.0),
]


# ============================================================================ photo renders

def _sky(h, w, top, bottom):
    t = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
    a = np.empty((h, w, 3), np.float32)
    a[:] = np.array(top, np.float32) * (1 - t) + np.array(bottom, np.float32) * t
    return a


def _building(a, x0, y0, x1, y1, wall, window, rng, *, floors=None, cols=None, lit=0.15):
    h, w = a.shape[:2]
    x0, x1 = max(0, int(x0)), min(w, int(x1))
    y0, y1 = max(0, int(y0)), min(h, int(y1))
    if x1 <= x0 or y1 <= y0:
        return
    bw, bh = x1 - x0, y1 - y0
    shade = np.linspace(1.06, 0.88, bw, dtype=np.float32)[None, :, None]
    a[y0:y1, x0:x1] = np.array(wall, np.float32) * shade
    floors = floors or max(3, bh // 60)
    cols = cols or max(2, bw // 55)
    fh, cw = bh / floors, bw / cols
    for r in range(floors):
        for k in range(cols):
            wx0 = int(x0 + k * cw + cw * 0.22)
            wx1 = int(x0 + (k + 1) * cw - cw * 0.22)
            wy0 = int(y0 + r * fh + fh * 0.25)
            wy1 = int(y0 + (r + 1) * fh - fh * 0.2)
            if wx1 > wx0 and wy1 > wy0:
                col = (255, 226, 150) if rng.random() < lit else window
                a[wy0:wy1, wx0:wx1] = np.array(col, np.float32) * (0.9 + 0.2 * rng.random())


def _tree(a, cx, cy, r, rng):
    h, w = a.shape[:2]
    ys, xs = np.ogrid[0:h, 0:w]
    tx0, tx1 = int(cx - r * 0.12), int(cx + r * 0.12)
    a[int(cy):int(cy + r * 1.3), max(0, tx0):max(0, tx1)] = (92, 64, 40)
    for _ in range(4):
        ox, oy = cx + (rng.random() - 0.5) * r * 0.8, cy - r * 0.2 + (rng.random() - 0.5) * r * 0.6
        rr = r * (0.55 + 0.4 * rng.random())
        y0, y1 = int(max(0, oy - rr)), int(min(h, oy + rr))
        x0, x1 = int(max(0, ox - rr)), int(min(w, ox + rr))
        if y1 <= y0 or x1 <= x0:
            continue
        m = ((xs[:, x0:x1] - ox) ** 2 + (ys[y0:y1] - oy) ** 2) <= rr * rr
        g = np.array((50 + rng.random() * 30, 110 + rng.random() * 40, 50 + rng.random() * 20), np.float32)
        sub = a[y0:y1, x0:x1]
        sub[m] = g


def _render_photo(idx, size, scene):
    w, h = size
    rng = np.random.default_rng(SEED + idx)
    if scene == "panorama":
        a = _sky(h, w, (70, 130, 205), (200, 225, 245))
        a[int(h * 0.78):] = (120, 150, 90)
        for i, (fx, fw, fh) in enumerate([(0.06, 0.13, 0.55), (0.24, 0.12, 0.66), (0.42, 0.16, 0.48), (0.64, 0.12, 0.62),
                                          (0.81, 0.13, 0.44)]):
            wall = [(222, 214, 200), (205, 190, 170), (230, 228, 222), (196, 170, 150), (215, 205, 190)][i]
            _building(a, w * fx, h * (0.80 - fh), w * (fx + fw), h * 0.80, wall, (70, 95, 130), rng)
        a[int(h * 0.80):int(h * 0.84)] = (150, 150, 150)
        for k in range(14):
            _tree(a, w * (0.03 + k * 0.07), h * 0.84, h * 0.05, rng)
    elif scene == "courtyard":
        a = _sky(h, w, (95, 150, 215), (210, 230, 248))
        a[int(h * 0.55):] = (110, 160, 95)
        _building(a, 0, h * 0.18, w * 0.30, h * 0.60, (235, 220, 196), (80, 100, 135), rng)
        _building(a, w * 0.70, h * 0.12, w, h * 0.60, (210, 200, 185), (80, 100, 135), rng)
        _building(a, w * 0.30, h * 0.35, w * 0.70, h * 0.58, (225, 210, 190), (80, 100, 135), rng, floors=5)
        a[int(h * 0.70):int(h * 0.92), int(w * 0.35):int(w * 0.65)] = (215, 180, 120)
        for k in range(6):
            x = int(w * (0.38 + k * 0.045))
            a[int(h * 0.72):int(h * 0.82), x:x + 18] = (200, 60, 60) if k % 2 else (60, 100, 200)
        for k in range(7):
            _tree(a, w * (0.05 + k * 0.15), h * 0.66, h * 0.07, rng)
    elif scene == "park":
        a = _sky(h, w, (80, 140, 210), (205, 228, 246))
        a[int(h * 0.45):] = (95, 150, 80)
        _building(a, w * 0.05, h * 0.10, w * 0.40, h * 0.47, (230, 230, 225), (75, 95, 125), rng)
        _building(a, w * 0.55, h * 0.05, w * 0.95, h * 0.47, (205, 185, 165), (75, 95, 125), rng)
        yy, xx = np.ogrid[0:h, 0:w]
        pond = ((xx - w * 0.5) / (w * 0.28)) ** 2 + ((yy - h * 0.75) / (h * 0.09)) ** 2 <= 1
        a[pond] = (90, 140, 190)
        for k in range(9):
            _tree(a, w * (0.06 + k * 0.11), h * (0.52 + 0.06 * (k % 2)), h * 0.06, rng)
    elif scene == "tower":
        a = _sky(h, w, (45, 105, 190), (185, 215, 245))
        _building(a, w * 0.22, h * 0.06, w * 0.78, h * 0.95, (236, 232, 226), (60, 90, 130), rng, floors=28, cols=7)
        a[int(h * 0.04):int(h * 0.06), int(w * 0.20):int(w * 0.80)] = (120, 120, 125)
        a[int(h * 0.95):] = (130, 130, 130)
        for k in range(4):
            _tree(a, w * (0.08 + k * 0.28), h * 0.93, h * 0.035, rng)
    else:  # sunset
        a = _sky(h, w, (250, 150, 90), (255, 225, 170))
        yy, xx = np.ogrid[0:h, 0:w]
        sun = ((xx - w * 0.75) ** 2 + (yy - h * 0.35) ** 2) <= (h * 0.09) ** 2
        a[sun] = (255, 240, 200)
        a[int(h * 0.70):] = (95, 110, 70)
        _building(a, w * 0.10, h * 0.40, w * 0.55, h * 0.72, (190, 120, 90), (70, 60, 80), rng, floors=3, lit=0.5)
        a[int(h * 0.30):int(h * 0.40), int(w * 0.28):int(w * 0.37)] = (170, 100, 70)
        for k in range(5):
            _tree(a, w * (0.60 + k * 0.08), h * 0.70, h * 0.06, rng)
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB").filter(ImageFilter.GaussianBlur(1.0))
    # labels
    d = ImageDraw.Draw(img)
    label = f"ЖК «Образцовый» — визуализация {idx} (ОБРАЗЕЦ)"
    fs = max(18, int(min(w, h) * 0.035))
    while fs > 12 and C.ff_pil_font("DejaVuSans-Bold", fs).getlength(label) > w * 0.94:
        fs -= 1
    f_small = C.ff_pil_font("DejaVuSans-Bold", fs)
    d.rectangle([0, h - int(min(w, h) * 0.07), w, h], fill=(20, 20, 25))
    d.text((int(w * 0.02), h - int(min(w, h) * 0.035)), label, font=f_small, fill=(240, 240, 240), anchor="lm")
    img = C.ff_specimen_overlay(img, "SPECIMEN", angle=20, color=(255, 255, 255), opacity=0.45,
                                size=int(min(w, h) * 0.18))
    a = np.asarray(img, np.float32) + rng.normal(0, 3.5, (h, w, 1)).astype(np.float32)
    return Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8), "RGB")


# ============================================================================ the booklet

_TEXT = {
    1: ("ЖК «Образцовый»", [
        "Квартиры в вымышленном районе Образцово. Сдача — IV квартал 2027 г.",
        "Буклет для покупателей · ОБРАЗЕЦ / SPECIMEN · все данные вымышлены",
    ]),
    2: ("О проекте", [
        "Пять корпусов",
        "от 9 до 24 этажей.",
        "",
        "Монолитный каркас,",
        "вентфасад из",
        "фиброцемента,",
        "панорамные окна",
        "в гостиных.",
        "",
        "Отделка white box",
        "во всех квартирах.",
        "",
        "Подземный паркинг",
        "на 640 мест.",
    ]),
    3: ("Двор без машин", [
        "Закрытый двор площадью",
        "2,4 га с прудом,",
        "детскими площадками",
        "трёх возрастных зон",
        "и беговой дорожкой.",
        "",
        "Въезд автомобилей",
        "во двор закрыт:",
        "парковка — только",
        "под землёй.",
        "",
        "Озеленение — 140 деревьев",
        "и 3 000 кустарников.",
    ]),
    4: ("Башня", [
        "Корпус 3 — 24 этажа,",
        "лобби с двойной высотой",
        "потолков 6,2 м,",
        "4 скоростных лифта.",
        "",
        "Видовые квартиры",
        "с 18 по 24 этаж,",
        "потолки 3,2 м.",
        "",
        "Терраса на кровле",
        "для жителей.",
    ]),
    5: ("Инфраструктура", [
        "Школа на 1 100 мест",
        "и детский сад на 250 мест",
        "в составе квартала.",
        "",
        "До станции метро",
        "«Образцовская» — 7 минут",
        "пешком (вымышленная).",
    ]),
    6: ("Контакты отдела продаж", [
        "Офис продаж: г. Образцовск, ул. Примерная, д. 1 (ОБРАЗЕЦ)",
        "Телефон: +7 000 000-00-00 · e-mail: sales@example.com · сайт: example.com/specimen",
        "Ежедневно с 10:00 до 20:00.",
        "",
        "Застройщик: ООО «СЗ Образец-Девелопмент» (вымышленная компания).",
        "Проектная декларация на сайте застройщика (ОБРАЗЕЦ).",
        "",
        "Все изображения — компьютерные визуализации; планировки и цены носят",
        "информационный характер и не являются публичной офертой.",
        "Документ создан для тестов и не относится к реальному жилому комплексу.",
    ]),
}

_PRICES = [("Студия, 24–29 м²", "от 7,9 млн ₽"), ("1-комнатная, 36–44 м²", "от 10,4 млн ₽"),
           ("2-комнатная, 54–68 м²", "от 14,8 млн ₽"), ("3-комнатная, 78–96 м²", "от 19,9 млн ₽")]


def _page_frame(c, k):
    w, h = PAGE
    c.setFillColorRGB(0.13, 0.22, 0.32)
    c.rect(0, h - 8, w, 8, stroke=0, fill=1)
    c.setFont("DejaVuSans", 8)
    c.setFillColorRGB(0.45, 0.45, 0.45)
    c.drawString(46, 12, "ОБРАЗЕЦ / SPECIMEN — ЖК «Образцовый» вымышлен")
    c.drawRightString(w - 46, 12, f"стр. {k} из 6")


def _draw_text_block(c, title, lines, x, y_top, *, title_size=24, size=12, leading=17):
    c.setFillColorRGB(0.13, 0.22, 0.32)
    c.setFont("DejaVuSans-Bold", title_size)
    c.drawString(x, y_top, title)
    c.setFillColorRGB(0.12, 0.12, 0.14)
    c.setFont("DejaVuSans", size)
    y = y_top - title_size - 8
    for ln in lines:
        c.drawString(x, y, ln)
        y -= leading
    return y


def _booklet_plain(jpegs):
    """Unencrypted booklet PDF bytes; jpegs: {idx: bytes}. Returns (bytes, placements)."""
    C.ff_register_rl_fonts("DejaVuSans", "DejaVuSans-Bold")
    buf = io.BytesIO()
    c = C.ff_rl_canvas(buf, title="ЖК «Образцовый» — буклет (ОБРАЗЕЦ / SPECIMEN)",
                       subject="Буклет застройщика, вымышленный ЖК (ОБРАЗЕЦ)", pagesize=PAGE)
    placements = {}
    by_page = {p[3]: p for p in PHOTOS}
    w_pt, h_pt = PAGE
    for k in range(1, 7):
        _page_frame(c, k)
        title, lines = _TEXT[k]
        ph = by_page.get(k)
        if ph:
            idx, (pw, phh), _scene, _page, scale, x, y = ph
            dw, dh = pw * scale, phh * scale
            assert x + dw <= w_pt - 20 and y + dh <= h_pt - 20, (idx, x + dw, y + dh)
            C.ff_rl_draw_jpeg(c, jpegs[idx], x, y, dw, dh)
            placements[idx] = {"page": k, "rect_pt": [round(x, 2), round(y, 2), round(x + dw, 2), round(y + dh, 2)],
                               "scale_pt_per_px": scale, "effective_dpi": round(72 / scale, 1)}
        if k == 1:
            c.setFillColorRGB(0.13, 0.22, 0.32)
            c.setFont("DejaVuSans-Bold", 26)
            c.drawString(46, 555, title)
            c.setFont("DejaVuSans", 11)
            c.setFillColorRGB(0.12, 0.12, 0.14)
            c.drawString(345, 563, lines[0])
            c.drawString(345, 547, lines[1])
        elif k == 6:
            y = _draw_text_block(c, title, lines, 60, 520, size=13, leading=20)
            c.saveState()
            c.setFillColorRGB(0.80, 0.15, 0.15)
            c.setFillAlpha(0.25)
            c.translate(w_pt / 2, 170)
            c.rotate(12)
            c.setFont("DejaVuSans-Bold", 60)
            c.drawCentredString(0, 0, "ОБРАЗЕЦ / SPECIMEN")
            c.restoreState()
        else:
            x_text = 46 if k != 4 else 60
            y = _draw_text_block(c, title, lines, x_text, 535)
            if k == 5:
                c.setFont("DejaVuSans-Bold", 12)
                c.setFillColorRGB(0.13, 0.22, 0.32)
                c.drawString(46, y - 14, "Цены (ОБРАЗЕЦ)")
                c.setFont("DejaVuSans", 11)
                c.setFillColorRGB(0.12, 0.12, 0.14)
                for i, (a, b) in enumerate(_PRICES):
                    yy = y - 34 - i * 18
                    c.drawString(46, yy, a)
                    c.drawRightString(300, yy, b)
        c.showPage()
    c.save()
    return buf.getvalue(), placements


@contextlib.contextmanager
def _seeded_token_bytes(seed):
    """Make pypdf's encryption randomness (secrets.token_bytes: file key, salts, AES IVs) deterministic."""
    import secrets

    state = {"ctr": 0}
    orig = secrets.token_bytes

    def fake(n=None):
        n = 32 if n is None else n
        out = b""
        while len(out) < n:
            out += hashlib.sha256(f"{seed}:{state['ctr']}".encode()).digest()
            state["ctr"] += 1
        return out[:n]

    secrets.token_bytes = fake
    try:
        yield
    finally:
        secrets.token_bytes = orig


def _encrypt(plain: bytes) -> bytes:
    from pypdf import PdfReader, PdfWriter

    try:
        import cryptography  # noqa: F401
    except ImportError as e:  # pragma: no cover
        raise SystemExit("f_pdf_password_extract needs `cryptography` (pip install -r requirements.txt)") from e
    with _seeded_token_bytes(SEED):
        w = PdfWriter(clone_from=PdfReader(io.BytesIO(plain)))
        w.add_metadata({"/Producer": "ОБРАЗЕЦ / SPECIMEN fixture (pypdf)"})
        w.encrypt(user_password=USER_PW, owner_password=OWNER_PW, algorithm="AES-256")
        out = io.BytesIO()
        w.write(out)
    return out.getvalue()


def _pdftotext_pages(pdf_path, n, password=None):
    texts = []
    for k in range(1, n + 1):
        args = [C.require_tool("pdftotext"), "-enc", "UTF-8", "-f", str(k), "-l", str(k)]
        if password:
            args += ["-upw", password]
        r = subprocess.run(args + [str(pdf_path), "-"], check=True, capture_output=True)
        texts.append(r.stdout.decode("utf-8"))
    return texts


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    idir = truth_dir / "buklet_images"
    idir.mkdir(parents=True, exist_ok=True)
    written = []

    jpegs, images_truth = {}, []
    for idx, size, scene, page, scale, x, y in PHOTOS:
        img = _render_photo(idx, size, scene)
        jb = C.ff_jpeg_bytes(img, JPEG_Q, subsampling=2, dpi=(72, 72))
        jpegs[idx] = jb
        p = idir / f"photo_{idx}_{size[0]}x{size[1]}.jpg"
        p.write_bytes(jb)
        written.append(str(p))
        images_truth.append({"index": idx, "file": f"buklet_images/{p.name}", "px": list(size), "scene": scene,
                             "bytes": len(jb), "sha256": hashlib.sha256(jb).hexdigest(), "jpeg_quality": JPEG_Q})

    plain, placements = _booklet_plain(jpegs)
    enc = _encrypt(plain)
    pdf_path = out_dir / FIXTURE
    pdf_path.write_bytes(enc)
    written.insert(0, str(pdf_path))
    for it in images_truth:
        it.update(placements[it["index"]])

    texts = _pdftotext_pages(pdf_path, 6, USER_PW)
    truth = {
        "fixture": FIXTURE,
        "pdf_bytes": len(enc),
        "pages": 6,
        "page_size_pt": [round(PAGE[0], 2), round(PAGE[1], 2)],
        "encryption": {"filter": "Standard", "V": 5, "R": 6, "algorithm": "AES-256", "user_password": USER_PW,
                       "owner_password": OWNER_PW,
                       "note": "the reply must not repeat the user password (reply_not_regex)"},
        "images": images_truth,
        "page_texts_pdftotext": texts,
        "page_text_joined": "\n".join(texts),
        "expected": {"unencrypted_pages": 6, "images": [list(p[1]) for p in PHOTOS], "page_jpgs": 6,
                     "page_jpg_min_long_side_px": 1600,
                     "page_jpg_long_side_at_dpi": {str(d): round(PAGE[0] / 72 * d) for d in (150, 200, 300)}},
    }
    written.append(C.ff_write_json(truth_dir / "buklet_ZhK.json", truth))
    return written


if __name__ == "__main__":
    base = HERE.parent
    for p in build(base / "out" / "f-pdf-password-extract", base / "truth"):
        print(p)
