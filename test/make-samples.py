#!/usr/bin/env python3
"""Render synthetic Traditional Chinese subtitle crops into /samples."""

import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "samples"
FONT_PATH = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"
W, H = 1200, 320


def scene(draw):
    draw.rectangle((0, 0, W, H), fill=(18, 52, 38))
    draw.ellipse((30, 10, 360, 220), fill=(42, 110, 64))
    draw.ellipse((760, 20, 1160, 180), fill=(24, 78, 92))
    draw.rounded_rectangle((40, 150, W - 40, H - 28), radius=28, fill=(10, 14, 24))


def draw_lines(img, lines, size):
    font = ImageFont.truetype(FONT_PATH, size)
    draw = ImageDraw.Draw(img)
    line_h = size + 16
    block_h = line_h * len(lines)
    y = 168 + max(0, (110 - block_h) // 2)
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        tw = bbox[2] - bbox[0]
        x = (W - tw) // 2
        draw.text((x + 2, y + 2), line, font=font, fill=(0, 0, 0))
        draw.text((x, y), line, font=font, fill=(255, 248, 230))
        y += line_h


def speckle(img, amount, seed):
    if amount <= 0:
        return img
    rnd = random.Random(seed)
    pix = img.load()
    for y in range(0, H, 2):
        for x in range(0, W, 2):
            delta = rnd.randint(-amount, amount)
            r, g, b = pix[x, y]
            pix[x, y] = (
                max(0, min(255, r + delta)),
                max(0, min(255, g + delta)),
                max(0, min(255, b + delta)),
            )
    return img


def render(path, lines, brightness=0, noise=0, size=64, seed=1):
    img = Image.new("RGB", (W, H))
    scene(ImageDraw.Draw(img))
    if lines:
        draw_lines(img, lines, size)
    if brightness:
        img = ImageEnhance.Brightness(img).enhance(1 + brightness / 100)
    speckle(img, noise, seed)
    img.save(path, "PNG")
    print(path.name)


def main():
    OUT.mkdir(exist_ok=True)
    render(OUT / "a-discover.png", ["耀西發現了一本神奇的書"])
    render(OUT / "a-discover-bright.png", ["耀西發現了一本神奇的書"], brightness=28, seed=2)
    render(OUT / "b-island.png", ["這座島上住著許多奇妙的生物"], size=58)
    render(OUT / "c-pages.png", ["把書頁翻開就能進入圖鑑的世界"], size=56)
    render(OUT / "d-hint.png", ["試著調查周圍的生物吧"])
    render(OUT / "e-two-lines.png", ["新的發現已記錄在圖鑑裡", "繼續探索這座小島吧"], size=52)
    render(OUT / "empty.png", [])
    render(OUT / "a-discover-speckle.png", ["耀西發現了一本神奇的書"], noise=3, seed=3)


if __name__ == "__main__":
    main()
