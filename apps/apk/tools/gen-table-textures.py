"""牌桌派生纹理生成器（国风湖亭 · 深翡翠桌面 · 暖木桌框 · 香槟金描边）。

只生成**底板类**资源：桌面石板、牌面托底、牌背、墨青面板。
麻将牌牌面本身是 `assets/resources/tiles/` 里的既有素材，一张都不重画。

    python apps/apk/tools/gen-table-textures.py <桌面背景图.png>

输出到 `assets/resources/{bg,table}/`，生成物进版本库，构建期不再依赖 Python。
"""
from __future__ import annotations

import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "assets", "resources")
BG_DIR = os.path.join(RES, "bg")
TABLE_DIR = os.path.join(RES, "table")

S = 2  # 超采样倍数：形状按 2x 画完再 LANCZOS 缩回，边缘不带锯齿

# 色彩 token 与 A2 图标系统同一套（mj-icon-design/manifest.md 顶部）
JADE_HI = (62, 140, 116)
JADE_LO = (23, 66, 56)
JADE_DEEP = (16, 50, 44)
WOOD_HI = (104, 72, 46)
WOOD_LO = (56, 38, 26)
GOLD = (217, 182, 111)
GOLD_DEEP = (154, 121, 70)
IVORY_HI = (252, 248, 238)
IVORY_LO = (223, 214, 191)
IVORY_EDGE = (186, 175, 148)
INK_HI = (26, 42, 48)
INK_LO = (12, 24, 30)


# ---------------------------------------------------------------- 通用画法

def scale(points: list[tuple[float, float]], pad: int) -> list[tuple[int, int]]:
    return [(int(x * S) + pad * S, int(y * S) + pad * S) for x, y in points]


def octagon(w: float, h: float, cut_top: float, cut_bottom: float, inset: float = 0) -> list[tuple[float, float]]:
    """切角矩形。上端切得多、下端切得少，桌板就有远窄近宽的透视，
    背景的两盏灯笼也能从上方两角露出来。inset 向内收，斜切量随之收窄。"""
    x0, y0, x1, y1 = inset, inset, w - inset, h - inset
    ct = max(0.0, cut_top - inset * 0.3)
    cb = max(0.0, cut_bottom - inset * 0.3)
    return [(x0 + ct, y0), (x1 - ct, y0), (x1, y0 + ct), (x1, y1 - cb),
            (x1 - cb, y1), (x0 + cb, y1), (x0, y1 - cb), (x0, y0 + ct)]


def poly_mask(size: tuple[int, int], polys: list[list[tuple[int, int]]]) -> Image.Image:
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for points in polys:
        draw.polygon(points, fill=255)
    return mask


def stroke_mask(size: tuple[int, int], pts: list[tuple[int, int]], width_1x: int, alpha: int) -> Image.Image:
    """闭合折线描边（`polygon` 没有 width，只能走 line + joint）。"""
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).line(list(pts) + [pts[0]], fill=alpha, width=width_1x * S, joint="curve")
    return mask


def vgrad(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    """竖向线性渐变（全 C 层合成；逐像素 Python 循环在这个尺寸下太慢）。"""
    w, h = size
    ramp = Image.linear_gradient("L").resize((w, h))
    return Image.composite(Image.new("RGB", size, bottom), Image.new("RGB", size, top), ramp)


def rgrad(size: tuple[int, int], center: tuple[int, int, int], edge: tuple[int, int, int]) -> Image.Image:
    """径向渐变：中心亮、四周暗，给玉桌面做出受光而不是塑料绿。"""
    w, h = size
    ramp = Image.radial_gradient("L").resize((w, h))
    return Image.composite(Image.new("RGB", size, edge), Image.new("RGB", size, center), ramp)


def paint(base: Image.Image, layer: Image.Image, mask: Image.Image) -> None:
    """把 layer 按 mask 叠进 base（就地）。"""
    base.paste(Image.composite(layer, base.convert("RGB"), mask), (0, 0), mask)


def band_mask(size: tuple[int, int], y0: int, y1: int, alpha: int) -> Image.Image:
    band = Image.new("L", size, 0)
    ImageDraw.Draw(band).rectangle([0, y0, size[0], y1], fill=alpha)
    return band


def save_rgba(face: Image.Image, mask: Image.Image, name: str, out_size: tuple[int, int]) -> None:
    out = Image.new("RGBA", face.size, (0, 0, 0, 0))
    out.paste(face, (0, 0), mask)
    out = out.resize(out_size, Image.LANCZOS)
    path = os.path.join(TABLE_DIR, name)
    out.save(path, optimize=True)
    print(f"{name:16s} {out_size[0]}x{out_size[1]}  {os.path.getsize(path) // 1024} KB")


# ---------------------------------------------------------------- 桌面石板

def build_slab() -> None:
    w, h, pad, frame = 1620, 890, 46, 40
    cut_top, cut_bottom = 240, 120
    size = ((w + pad * 2) * S, (h + pad * 2) * S)
    outer = scale(octagon(w, h, cut_top, cut_bottom), pad)
    inner = scale(octagon(w, h, cut_top, cut_bottom, frame), pad)

    body = Image.new("RGB", size, (10, 20, 18))

    # 1) 暖木桌框：竖向渐变打底，木纹只做到「近看才有」的程度
    #    （早先条纹对比太强，缩到牌桌上像瓦楞纸，这里把间距拉开、色差压小）
    wood = vgrad(size, WOOD_HI, WOOD_LO)
    grain = ImageDraw.Draw(wood)
    step = 13 * S
    for y in range(0, size[1], step):
        tone = WOOD_LO if (y // step) % 3 == 0 else tuple(min(255, c + 12) for c in WOOD_HI)
        grain.line([(0, y), (size[0], y)], fill=tone, width=2 * S)
    wood = wood.filter(ImageFilter.GaussianBlur(3.2 * S))
    paint(body, wood, poly_mask(size, [outer]))

    # 2) 玉面：径向受光打底，再叠一层竖向压暗收住上亮下暗
    jade = rgrad(size, JADE_HI, JADE_LO)
    jade = Image.blend(jade, vgrad(size, (250, 250, 250), (0, 0, 0)), 0.2)
    paint(body, jade, poly_mask(size, [inner]))

    # 3) 桌芯暗纹：几圈同心环，透明度压到几乎看不见
    cx, cy = size[0] / 2, size[1] / 2
    decor = Image.new("RGB", size, GOLD)
    decor_mask = Image.new("L", size, 0)
    dm = ImageDraw.Draw(decor_mask)
    for radius, alpha in ((230, 30), (212, 18), (150, 14), (176, 20), (96, 16)):
        r = radius * S
        dm.ellipse([cx - r, cy - r, cx + r, cy + r], outline=alpha, width=max(1, S))
    for angle in range(0, 360, 45):
        import math
        r0, r1 = 236 * S, 254 * S
        dm.line([(cx + r0 * math.cos(math.radians(angle)), cy + r0 * math.sin(math.radians(angle))),
                 (cx + r1 * math.cos(math.radians(angle)), cy + r1 * math.sin(math.radians(angle)))],
                fill=16, width=S)
    decor_mask = decor_mask.filter(ImageFilter.GaussianBlur(0.9 * S))
    paint(body, decor, decor_mask)

    # 4) 香槟金细边：外轮廓一道、玉面内缘一道
    gold = Image.new("RGB", size, GOLD)
    for pts, width, alpha in ((outer, 3, 205), (inner, 2, 150)):
        stroke = stroke_mask(size, pts, width, alpha)
        paint(body, gold, stroke)

    # 5) 落影：整块石板往下压一点，桌缘才有厚度
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    shadow = Image.new("L", size, 0)
    ImageDraw.Draw(shadow).polygon([(x, y + 14 * S) for x, y in outer], fill=140)
    shadow = shadow.filter(ImageFilter.GaussianBlur(15 * S))
    canvas.paste(Image.new("RGBA", size, (4, 12, 12, 255)), (0, 0), shadow)
    canvas.paste(body.convert("RGBA"), (0, 0), poly_mask(size, [outer]))

    canvas = canvas.resize((w + pad * 2, h + pad * 2), Image.LANCZOS)
    path = os.path.join(TABLE_DIR, "slab.png")
    canvas.save(path, optimize=True)
    print(f"{'slab.png':16s} {canvas.size[0]}x{canvas.size[1]}  {os.path.getsize(path) // 1024} KB")


# ---------------------------------------------------------------- 牌面托底

def build_tile_face() -> None:
    """象牙牌面底板：正好垫在既有牌面线稿下面（牌面一个字都不重画）。"""
    w, h, radius = 250, 358, 20
    size = (w * S, h * S)
    face = vgrad(size, IVORY_HI, IVORY_LO)
    # 顶部高光 + 底部厚度：读起来是立着的牌，不是贴纸
    face = Image.composite(Image.new("RGB", size, (255, 255, 255)), face,
                           band_mask(size, 0, int(0.07 * h * S), 110))
    face = Image.composite(Image.new("RGB", size, IVORY_EDGE), face,
                           band_mask(size, int(0.90 * h * S), h * S, 165))
    # 内缘一道极细香槟金，牌面线稿压在上面正好收口
    edge = Image.new("L", size, 0)
    ImageDraw.Draw(edge).rounded_rectangle([3 * S, 3 * S, (w - 3) * S, (h - 3) * S], radius * S,
                                           outline=80, width=S)
    face = Image.composite(Image.new("RGB", size, GOLD_DEEP), face, edge)

    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([S, S, (w - 1) * S, (h - 1) * S], (radius + 1) * S, fill=255)
    save_rgba(face, mask, "tile-face.png", (w, h))


def build_tile_back() -> None:
    """牌背：九宫格底板（上家 36×40、左右 40×30 两种比例共用一张）。"""
    w = h = 72
    size = (w * S, h * S)
    face = vgrad(size, JADE_HI, JADE_LO)
    face = Image.composite(Image.new("RGB", size, (126, 196, 170)), face,
                           band_mask(size, 0, int(0.28 * h * S), 70))
    face = Image.composite(Image.new("RGB", size, JADE_DEEP), face,
                           band_mask(size, int(0.84 * h * S), h * S, 150))
    inner = Image.new("L", size, 0)
    ImageDraw.Draw(inner).rounded_rectangle([6 * S, 6 * S, (w - 6) * S, (h - 6) * S], 12 * S,
                                            outline=110, width=S)
    face = Image.composite(Image.new("RGB", size, GOLD), face, inner)

    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size[0] - S, size[1] - S], 20 * S, fill=255)
    save_rgba(face, mask, "tile-back.png", (w, h))


def build_panel_ink() -> None:
    """墨青面板：半透明 + 香槟金细边，浮层/座位卡/牌匾共用（九宫格）。"""
    w = h = 96
    size = (w * S, h * S)
    face = vgrad(size, INK_HI, INK_LO)
    face = Image.composite(Image.new("RGB", size, (74, 100, 104)), face,
                           band_mask(size, 0, int(0.11 * h * S), 55))
    border = Image.new("L", size, 0)
    ImageDraw.Draw(border).rounded_rectangle([S, S, size[0] - 2 * S, size[1] - 2 * S], 25 * S,
                                             outline=145, width=S)
    face = Image.composite(Image.new("RGB", size, GOLD), face, border)

    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size[0] - S, size[1] - S], 26 * S, fill=232)
    save_rgba(face, mask, "panel-ink.png", (w, h))


def build_background(source: str) -> None:
    """湖亭背景：等比铺满 1920×1080 后转 JPEG —— 背景不需要 alpha，PNG 白占 2MB。"""
    im = Image.open(source).convert("RGB")
    im = im.resize((1920, 1080), Image.LANCZOS)
    # 轻微压暗 + 向墨青偏色：白牌才不会被背景抢走
    im = Image.blend(im, Image.new("RGB", im.size, (24, 40, 44)), 0.16)
    os.makedirs(BG_DIR, exist_ok=True)
    path = os.path.join(BG_DIR, "table-lake.jpg")
    im.save(path, quality=82, optimize=True, progressive=True)
    print(f"{'table-lake.jpg':16s} 1920x1080  {os.path.getsize(path) // 1024} KB")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    os.makedirs(TABLE_DIR, exist_ok=True)
    build_background(sys.argv[1])
    build_slab()
    build_tile_face()
    build_tile_back()
    build_panel_ink()


main()
