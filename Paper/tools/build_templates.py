#!/usr/bin/env python3
"""
يولّد قوالب «ورقة القرار» (PNG بنافذة شفافة) + الصور المصغّرة + ملف templates.js

    python tools/build_templates.py

القالب = صورة PNG فيها نافذة شفافة تظهر منها الورقة. الصفحة تُرسم تحت القالب،
لذلك أي شيء يخرج عن النافذة يغطّيه القالب تلقائياً.

المتطلبات: Pillow, numpy  (و psd-tools فقط لإعادة تصدير قالب البيج من ملف PSD)
"""
import json
import math
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "tools" / "assets"
OUT = ROOT / "templates"
THUMBS = OUT / "thumbs"
FONT = ROOT / "fonts" / "itfQomraArabic-Bold.otf"

# ألوان الهوية
GOLD = (184, 166, 120)
GOLD_DEEP = (150, 130, 88)
GREEN = (9, 66, 57)
GREEN_DEEP = (5, 36, 31)
CREAM = (240, 234, 220)
WHITE = (255, 255, 255)

HANDLE = "@SyMOHEASR"


# ───────────────────────── أدوات رسم عامة ─────────────────────────

def lerp_stops(t, stops):
    """t: مصفوفة 0..1 ، stops: [(pos, (r,g,b)), ...] → مصفوفة HxWx3"""
    pos = np.array([s[0] for s in stops], dtype=np.float32)
    cols = np.array([s[1] for s in stops], dtype=np.float32)
    out = np.empty(t.shape + (3,), dtype=np.float32)
    for c in range(3):
        out[..., c] = np.interp(t, pos, cols[:, c])
    return out


def linear_gradient(w, h, stops, angle=90.0):
    """angle=90 → من الأعلى للأسفل ، 0 → من اليسار لليمين"""
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    a = math.radians(angle)
    dx, dy = math.cos(a), math.sin(a)
    proj = (xs - w / 2) * dx + (ys - h / 2) * dy
    span = abs(w * dx) + abs(h * dy)
    return lerp_stops(np.clip(proj / span + 0.5, 0, 1), stops)


def radial_field(w, h, cx, cy, radius):
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    return np.clip(np.hypot(xs - cx, ys - cy) / radius, 0, 1)


def blend(base, color, alpha):
    """base: HxWx3 ، color: (r,g,b) أو HxWx3 ، alpha: HxW أو رقم"""
    a = alpha[..., None] if isinstance(alpha, np.ndarray) else alpha
    return base * (1 - a) + np.asarray(color, dtype=np.float32) * a


def sdf_round_rect(w, h, box, radii):
    """مسافة موقّعة لمستطيل بأنصاف أقطار مختلفة (tl, tr, br, bl). سالبة داخل الشكل."""
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hw, hh = (x1 - x0) / 2, (y1 - y0) / 2
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    px, py = xs + 0.5 - cx, ys + 0.5 - cy
    tl, tr, br, bl = radii
    r = np.where(px < 0, np.where(py < 0, tl, bl), np.where(py < 0, tr, br)).astype(np.float32)
    qx, qy = np.abs(px) - hw + r, np.abs(py) - hh + r
    return np.minimum(np.maximum(qx, qy), 0) + np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) - r


def coverage(sdf):
    return np.clip(0.5 - sdf, 0, 1)


def drop_shadow(rgb, cover, dx, dy, blur, opacity, color=(0, 0, 0)):
    img = Image.fromarray((cover * 255).astype(np.uint8), "L")
    img = img.transform(img.size, Image.AFFINE, (1, 0, -dx, 0, 1, -dy))
    img = img.filter(ImageFilter.GaussianBlur(blur))
    a = np.asarray(img, dtype=np.float32) / 255 * opacity
    # multiply
    mult = np.asarray(color, dtype=np.float32) / 255
    return rgb * (1 - a[..., None] * (1 - mult))


def grain(rgb, amount=2.0, seed=7):
    rng = np.random.default_rng(seed)
    n = rng.normal(0, amount, rgb.shape[:2]).astype(np.float32)
    return rgb + n[..., None]


def to_layer(arr):
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


def alpha_over(rgb, layer, xy=(0, 0), opacity=1.0):
    """يركّب صورة RGBA (PIL) فوق مصفوفة RGB عائمة."""
    layer = layer.convert("RGBA")
    h, w = rgb.shape[:2]
    x, y = int(round(xy[0])), int(round(xy[1]))
    x0, y0 = max(x, 0), max(y, 0)
    x1, y1 = min(x + layer.width, w), min(y + layer.height, h)
    if x1 <= x0 or y1 <= y0:
        return rgb
    part = np.asarray(layer.crop((x0 - x, y0 - y, x1 - x, y1 - y)), dtype=np.float32)
    a = part[..., 3:4] / 255 * opacity
    rgb[y0:y1, x0:x1] = rgb[y0:y1, x0:x1] * (1 - a) + part[..., :3] * a
    return rgb


def tint(rgba, color):
    """يحوّل صورة RGBA إلى لون واحد مع الحفاظ على قناة الشفافية."""
    a = rgba.getchannel("A")
    out = Image.new("RGBA", rgba.size, tuple(color) + (255,))
    out.putalpha(a)
    return out


def fit_width(img, width):
    return img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)


def fit_height(img, height):
    return img.resize((round(img.width * height / img.height), height), Image.LANCZOS)


# ───────────────────────── زخارف هندسية ─────────────────────────

def star_points(cx, cy, R, rot=0.0):
    """نجمة ثمانية (مربعان متداخلان) — 16 رأساً."""
    r = R * 0.7654
    pts = []
    for i in range(16):
        ang = math.radians(rot + i * 22.5)
        rad = R if i % 2 == 0 else r
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    return pts


def square_points(cx, cy, R, rot=0.0):
    return [(cx + R * math.cos(math.radians(rot + k * 90)),
             cy + R * math.sin(math.radians(rot + k * 90))) for k in range(4)]


def ornament_layer(size, items, color, ss=3):
    """يرسم مجموعة أشكال خطية بإحاطة ناعمة. items: [(kind, cx, cy, R, line_width, alpha)]"""
    w, h = size
    layer = Image.new("RGBA", (w * ss, h * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for kind, cx, cy, R, lw, alpha in items:
        col = tuple(color) + (int(255 * alpha),)
        if kind == "fstar":
            d.polygon(star_points(cx * ss, cy * ss, R * ss), fill=col)
            continue
        if kind == "star":
            pts = star_points(cx * ss, cy * ss, R * ss)
        elif kind == "sq0":
            pts = square_points(cx * ss, cy * ss, R * ss, 45)
        else:
            pts = square_points(cx * ss, cy * ss, R * ss, 0)
        d.line(pts + [pts[0], pts[1]], fill=col, width=max(1, int(lw * ss)), joint="curve")
    return layer.resize((w, h), Image.LANCZOS)


def khatam(cx, cy, R, lw, alpha, rings=3):
    """وحدة زخرفية: نجمة ثمانية بحلقات متداخلة."""
    items = []
    for k in range(rings):
        s = R * (1 - k * 0.27)
        items.append(("star", cx, cy, s, lw, alpha))
    items.append(("sq0", cx, cy, R * 0.72 * 0.7071 * 1.4142 / 1.4142, lw, alpha * 0.6))
    return items


def lattice_items(w, h, spacing, lw, alpha, offset=(0, 0)):
    items = []
    cols = int(w / spacing) + 3
    rows = int(h / spacing) + 3
    for j in range(-1, rows):
        for i in range(-1, cols):
            cx = offset[0] + i * spacing
            cy = offset[1] + j * spacing
            items.append(("star", cx, cy, spacing / 2 * 1.0, lw, alpha))
            items.append(("sq0", cx + spacing / 2, cy + spacing / 2, spacing / 2 * 0.62, lw, alpha * 0.8))
    return items


# ───────────────────────── العناصر المشتركة ─────────────────────────

def load_logo(variant, height=None, width=None, color=None):
    img = Image.open(ASSETS / f"logo-{variant}.png").convert("RGBA")
    if color is not None:
        img = tint(img, color)
    if width:
        img = fit_width(img, width)
    elif height:
        img = fit_height(img, height)
    return img


def load_icons(color=None, size=40):
    icons = []
    for n in ("facebook", "youtube", "telegram"):
        im = Image.open(ASSETS / f"icon-{n}.png").convert("RGBA")
        if color is not None:
            im = tint(im, color)
        icons.append(im.resize((size, size), Image.LANCZOS))
    return icons


def social_strip(color, size=38, gap=12, font_size=27, text_gap=16):
    """شريط: 3 أيقونات + المعرّف. يعيد صورة RGBA."""
    icons = load_icons(color, size)
    font = ImageFont.truetype(str(FONT), font_size)
    tw = int(font.getlength(HANDLE))
    w = len(icons) * size + (len(icons) - 1) * gap + text_gap + tw + 4
    strip = Image.new("RGBA", (w, size), (0, 0, 0, 0))
    x = 0
    for ic in icons:
        strip.alpha_composite(ic, (x, 0))
        x += size + gap
    x += text_gap - gap
    d = ImageDraw.Draw(strip)
    asc, desc = font.getmetrics()
    d.text((x, (size - (asc + desc)) // 2 + 1), HANDLE, font=font, fill=tuple(color) + (255,))
    return strip


class Card:
    """بطاقة بيضاء + نافذة شفافة بهامش ثابت (نفس فكرة قوالب PSD)."""

    def __init__(self, box, radii, inset):
        self.box = box
        self.radii = radii
        self.inset = inset
        x0, y0, x1, y1 = box
        self.window = (x0 + inset, y0 + inset, x1 - inset, y1 - inset)
        # نصف قطر النافذة الداخلية = الخارجي − الهامش (+3 كما في قوالبك)
        self.win_radii = tuple(max(r - inset + 3, 0) if r else 0 for r in radii)

    def draw(self, rgb, shadow):
        w, h = rgb.shape[1], rgb.shape[0]
        outer = coverage(sdf_round_rect(w, h, self.box, self.radii))
        if shadow:
            rgb = drop_shadow(rgb, outer, **shadow)
        rgb = blend(rgb, WHITE, outer)
        return rgb

    def punch(self, w, h):
        """قناع النافذة (1 = شفاف)."""
        return coverage(sdf_round_rect(w, h, self.window, self.win_radii))


def finish(rgb, card, name, size, extra_grain=None):
    w, h = size
    hole = card.punch(w, h)
    alpha = (255 * (1 - hole)).round().astype(np.uint8)
    rgb = np.where(hole[..., None] >= 0.999, 255.0, rgb)
    out = np.dstack([np.clip(rgb, 0, 255).round().astype(np.uint8), alpha])
    img = Image.fromarray(out, "RGBA")
    # تنظيف RGB داخل النافذة (شفاف تماماً) لتقليل حجم الملف
    return img


# ───────────────────────── القوالب الجديدة (4:5) ─────────────────────────

W45, H45 = 1080, 1350
# هندسة موحّدة تناسب ورقة A4: نافذة ≈ 766×1084
CARD45 = (143, 164, 937, 1276)


def footer_y(card, strip_h):
    return int((card.box[3] + H45) / 2 - strip_h / 2) + 1


def tpl_pure():
    w, h = W45, H45
    field = radial_field(w, h, w * 0.5, h * 0.48, 860)
    rgb = lerp_stops(field, [(0, (251, 249, 243)), (0.55, (245, 241, 231)), (1, (236, 230, 214))])
    # نسيج نجمي خفيف جداً يتلاشى نحو الوسط
    lat = ornament_layer((w, h), lattice_items(w, h, 150, 1.6, 0.20, (30, 20)), GOLD)
    mask = np.clip((radial_field(w, h, w * 0.5, h * 0.5, 720) - 0.35) / 0.65, 0, 1)
    la = np.asarray(lat, dtype=np.float32)
    la[..., 3] *= mask * 0.85
    rgb = alpha_over(rgb, Image.fromarray(la.astype(np.uint8), "RGBA"))
    # نجمتان كبيرتان في زاويتين متقابلتين
    big = ornament_layer((w, h), khatam(30, 30, 300, 2.2, 0.32) + khatam(w - 20, h - 10, 340, 2.2, 0.32), GOLD)
    rgb = alpha_over(rgb, big)
    rgb = grain(rgb, 1.4)
    card = Card(CARD45, (26, 26, 26, 26), 12)
    rgb = card.draw(rgb, dict(dx=0, dy=8, blur=16, opacity=0.20, color=(60, 45, 20)))
    logo = load_logo("dark", width=262)
    rgb = alpha_over(rgb, logo, (card.box[2] - logo.width, 22))
    strip = social_strip(GREEN, size=32, gap=10, font_size=23, text_gap=14)
    rgb = alpha_over(rgb, strip, (card.box[0], footer_y(card, strip.height)))
    return finish(rgb, card, "pure", (w, h))


def tpl_deep():
    w, h = W45, H45
    rgb = linear_gradient(w, h, [(0, (13, 78, 67)), (0.55, (8, 52, 44)), (1, (4, 30, 26))], 90)
    glow = 1 - radial_field(w, h, 150, 120, 760)
    rgb = blend(rgb, (36, 120, 104), glow ** 2 * 0.55)
    lat = ornament_layer((w, h), lattice_items(w, h, 150, 1.6, 0.16, (30, 20)), (255, 255, 255))
    mask = np.clip((radial_field(w, h, w * 0.5, h * 0.5, 720) - 0.4) / 0.6, 0, 1)
    la = np.asarray(lat, dtype=np.float32)
    la[..., 3] *= mask * 0.6
    rgb = alpha_over(rgb, Image.fromarray(la.astype(np.uint8), "RGBA"))
    # إطار ذهبي رفيع حول القالب كله
    frame = coverage(np.abs(sdf_round_rect(w, h, (22, 22, w - 22, h - 22), (18, 18, 18, 18))) - 0.8)
    rgb = blend(rgb, GOLD, frame * 0.7)
    rgb = grain(rgb, 2.0)
    card = Card(CARD45, (64, 0, 64, 0), 14)
    rgb = card.draw(rgb, dict(dx=0, dy=10, blur=18, opacity=0.45))
    logo = load_logo("light", width=250)
    rgb = alpha_over(rgb, logo, (card.box[2] - logo.width, 30))
    strip = social_strip(WHITE, size=32, gap=10, font_size=23, text_gap=14)
    rgb = alpha_over(rgb, strip, (card.box[0], footer_y(card, strip.height)))
    return finish(rgb, card, "deep", (w, h))


def tpl_gold():
    w, h = W45, H45
    rgb = linear_gradient(w, h, [(0, (245, 236, 208)), (0.5, (222, 205, 156)), (1, (189, 168, 112))], 62)
    # شعاع ضوء قطري ناعم
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    band = np.exp(-(((xs * 0.9 + ys * 0.45) - 900) / 260) ** 2)
    rgb = blend(rgb, (255, 250, 232), band * 0.38)
    lat = ornament_layer((w, h), lattice_items(w, h, 150, 1.6, 0.30, (30, 20)), (255, 255, 255))
    la = np.asarray(lat, dtype=np.float32)
    la[..., 3] *= 0.55
    rgb = alpha_over(rgb, Image.fromarray(la.astype(np.uint8), "RGBA"))
    rgb = grain(rgb, 1.6)
    card = Card(CARD45, (64, 0, 64, 0), 14)
    rgb = card.draw(rgb, dict(dx=0, dy=10, blur=18, opacity=0.34, color=(70, 50, 10)))
    logo = load_logo("dark", width=250, color=GREEN)
    rgb = alpha_over(rgb, logo, (card.box[2] - logo.width, 30))
    strip = social_strip(GREEN, size=32, gap=10, font_size=23, text_gap=14)
    rgb = alpha_over(rgb, strip, (card.box[0], footer_y(card, strip.height)))
    return finish(rgb, card, "gold", (w, h))


def tpl_star():
    w, h = W45, H45
    field = radial_field(w, h, w * 0.5, h * 0.5, 900)
    rgb = lerp_stops(field, [(0, (238, 231, 214)), (0.6, (232, 224, 205)), (1, (219, 209, 184))])
    rgb = grain(rgb, 1.6)
    # إطار مزدوج بأسلوب الشهادات
    outer = (18, 18, w - 18, h - 18)
    inner = (27, 27, w - 27, h - 27)
    for box, lw, a in ((outer, 2.2, 0.95), (inner, 1.0, 0.75)):
        line = coverage(np.abs(sdf_round_rect(w, h, box, (0, 0, 0, 0))) - lw / 2)
        rgb = blend(rgb, GOLD_DEEP, line * a)
    # نجمة ثمانية مصمتة في كل زاوية
    orn = []
    for (cx, cy) in ((18, 18), (w - 18, 18), (18, h - 18), (w - 18, h - 18)):
        orn += [("fstar", cx, cy, 24, 0, 1.0)]
    corners = ornament_layer((w, h), orn, GOLD_DEEP)
    rgb = alpha_over(rgb, corners)
    for (cx, cy) in ((18, 18), (w - 18, 18), (18, h - 18), (w - 18, h - 18)):
        dot = coverage(np.hypot(*np.mgrid[0:h, 0:w].astype(np.float32)[::-1] - np.array([cx, cy], dtype=np.float32)[:, None, None]) - 6)
        rgb = blend(rgb, (238, 231, 214), dot * 1.0)
    card = Card(CARD45, (26, 26, 26, 26), 12)
    rgb = card.draw(rgb, dict(dx=0, dy=8, blur=16, opacity=0.22, color=(60, 45, 20)))
    logo = load_logo("dark", width=236)
    rgb = alpha_over(rgb, logo, ((w - logo.width) // 2, 40))
    strip = social_strip(GREEN, size=27, gap=9, font_size=20, text_gap=12)
    rgb = alpha_over(rgb, strip, ((w - strip.width) // 2, 1287))
    return finish(rgb, card, "star", (w, h))


def tpl_sage():
    w, h = W45, H45
    rgb = linear_gradient(w, h, [(0, (232, 240, 234)), (0.55, (208, 224, 214)), (1, (184, 206, 194))], 62)
    hl = 1 - radial_field(w, h, w * 0.75, h * 0.18, 720)
    rgb = blend(rgb, (248, 252, 249), hl ** 2 * 0.55)
    lat = ornament_layer((w, h), lattice_items(w, h, 150, 1.6, 0.20, (30, 20)), GREEN)
    mask = np.clip((radial_field(w, h, w * 0.5, h * 0.5, 720) - 0.3) / 0.7, 0, 1)
    la = np.asarray(lat, dtype=np.float32)
    la[..., 3] *= mask * 0.75
    rgb = alpha_over(rgb, Image.fromarray(la.astype(np.uint8), "RGBA"))
    big = ornament_layer((w, h), khatam(w - 10, 20, 320, 2.2, 0.26) + khatam(20, h - 20, 300, 2.2, 0.26), GREEN)
    rgb = alpha_over(rgb, big)
    rgb = grain(rgb, 1.4)
    card = Card(CARD45, (0, 64, 0, 64), 14)          # زوايا معكوسة عن قوالب الأخضر والذهبي
    rgb = card.draw(rgb, dict(dx=0, dy=10, blur=18, opacity=0.26, color=(15, 45, 35)))
    logo = load_logo("dark", width=250, color=GREEN)
    rgb = alpha_over(rgb, logo, (card.box[2] - logo.width, 30))
    strip = social_strip(GREEN, size=32, gap=10, font_size=23, text_gap=14)
    rgb = alpha_over(rgb, strip, (card.box[0], footer_y(card, strip.height)))
    return finish(rgb, card, "sage", (w, h))


# ───────────────────────── ستوري 9:16 ─────────────────────────

def tpl_story():
    w, h = 1080, 1920
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    # قطري: بيج في الأعلى → أخضر في الأسفل
    split = (ys - (1010 - xs * 0.16))
    t = np.clip(split / 3.0 + 0.5, 0, 1)              # حد حاد مع تنعيم بكسل واحد
    beige = linear_gradient(w, h, [(0, (246, 241, 229)), (1, (232, 224, 205))], 90)
    green = linear_gradient(w, h, [(0, (12, 74, 63)), (1, (4, 30, 26))], 90)
    rgb = beige * (1 - t[..., None]) + green * t[..., None]
    # نسيج نجمي على النصفين
    lat_gold = ornament_layer((w, h), lattice_items(w, h, 170, 1.6, 0.20, (40, 30)), GOLD)
    la = np.asarray(lat_gold, dtype=np.float32)
    la[..., 3] *= (1 - t) * 0.9
    rgb = alpha_over(rgb, Image.fromarray(la.astype(np.uint8), "RGBA"))
    lat_w = ornament_layer((w, h), lattice_items(w, h, 170, 1.6, 0.14, (40, 30)), WHITE)
    lw_ = np.asarray(lat_w, dtype=np.float32)
    lw_[..., 3] *= t * 0.7
    rgb = alpha_over(rgb, Image.fromarray(lw_.astype(np.uint8), "RGBA"))
    # خط ذهبي رفيع على حافة الانقسام
    edge = np.exp(-((split) / 1.4) ** 2)
    rgb = blend(rgb, GOLD, edge * 0.9)
    rgb = grain(rgb, 1.8)
    card = Card((70, 300, 1010, 1610), (64, 0, 64, 0), 14)
    rgb = card.draw(rgb, dict(dx=0, dy=12, blur=20, opacity=0.38, color=(20, 30, 20)))
    logo = load_logo("dark", width=300)
    rgb = alpha_over(rgb, logo, (card.box[2] - logo.width, 92))
    strip = social_strip(WHITE, size=38, gap=12, font_size=28, text_gap=16)
    rgb = alpha_over(rgb, strip, (card.box[0], 1610 + (h - 1610) // 2 - strip.height // 2 - 20))
    return finish(rgb, card, "story", (w, h))


# ───────────────────────── قوالب PSD الحالية ─────────────────────────

def tpl_from_psd(psd_path, inset=16, radii=(70, 0, 70, 0)):
    """يعيد تصدير قالب من ملف PSD: يركّب الطبقات ثم يثقب نافذة داخل «Rectangle 1»."""
    from psd_tools import PSDImage
    psd = PSDImage.open(str(psd_path))
    comp = psd.composite().convert("RGB")
    rect = next(l for l in psd.descendants() if l.name == "Rectangle 1")
    x0, y0, x1, y1 = rect.origination[0].bbox if hasattr(rect, "origination") and rect.origination else rect.bbox
    card = Card((round(x0), round(y0), round(x1), round(y1)), radii, inset)
    rgb = np.asarray(comp, dtype=np.float32)
    return finish(rgb, card, "beige", comp.size)


def window_of(img):
    a = np.asarray(img.getchannel("A"))
    ys, xs = np.where(a < 8)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    return [x0, y0, x1 - x0, y1 - y0]


def make_thumb(img, path, width=300):
    t = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    t.save(path, "WEBP", quality=82, alpha_quality=100, method=6)


def main():
    OUT.mkdir(exist_ok=True)
    THUMBS.mkdir(exist_ok=True)
    only = set(sys.argv[1:])
    specs = [
        # id, الاسم، الدالة، وصف قصير
        ("beige", "بيج زخرفي", None),
        ("green", "أخضر ملكي", None),
        ("pure", "نقاء", tpl_pure),
        ("deep", "أخضر عميق", tpl_deep),
        ("gold", "ذهبي هادئ", tpl_gold),
        ("sage", "أخضر هادئ", tpl_sage),
        ("star", "إطار الشهادة", tpl_star),
        ("story", "ستوري", tpl_story),
    ]
    manifest = []
    for tid, name, fn in specs:
        path = OUT / f"{tid}.png"
        if tid == "beige":
            psd = next(ROOT.glob("ورقة قرار جديد.psd"), None)
            if (not only or tid in only) and psd is not None:
                print("psd →", tid)
                tpl_from_psd(psd, inset=16, radii=(70, 0, 70, 0)).save(path, optimize=True)
        elif tid == "green":
            src = ROOT / "ورقة-قرار.png"
            if (not only or tid in only) and src.exists():
                print("copy →", tid)
                shutil.copyfile(src, path)
        elif not only or tid in only:
            print("build →", tid)
            fn().save(path, optimize=True)
        if not path.exists():
            print("  (missing, skipped)", tid)
            continue
        img = Image.open(path).convert("RGBA")
        make_thumb(img, THUMBS / f"{tid}.webp")
        manifest.append({
            "id": tid, "name": name,
            "file": f"templates/{tid}.png", "thumb": f"templates/thumbs/{tid}.webp",
            "w": img.width, "h": img.height, "win": window_of(img),
        })
    def line(t):
        q = lambda v: json.dumps(v, ensure_ascii=False)
        return ("  { id: %s, name: %s, file: %s, thumb: %s, w: %d, h: %d, win: [%s] }"
                % (q(t["id"]), q(t["name"]), q(t["file"]), q(t["thumb"]), t["w"], t["h"],
                   ", ".join(str(v) for v in t["win"])))

    js = ("// ملف مولَّد تلقائياً بواسطة tools/build_templates.py — يمكن تعديل الأسماء والترتيب يدوياً.\n"
          "// win = [x, y, العرض, الارتفاع] لنافذة الورقة الشفافة داخل القالب (اختياري: تُكتشف تلقائياً إن حُذفت).\n"
          "window.TEMPLATES = [\n" + ",\n".join(line(t) for t in manifest) + "\n];\n")
    (ROOT / "templates.js").write_text(js, encoding="utf-8")
    print("templates.js written:", len(manifest), "templates")


if __name__ == "__main__":
    main()
