"""Draw the home-screen icons: a gradient rounded square with a camera-lens ring."""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "docs"
STOPS = [(255, 178, 63), (255, 90, 54), (214, 36, 159), (106, 92, 255)]


def lerp(a, b, t):
    return tuple(int(x + (y - x) * t) for x, y in zip(a, b))


def gradient(t):
    t = min(max(t, 0), 1) * (len(STOPS) - 1)
    i = min(int(t), len(STOPS) - 2)
    return lerp(STOPS[i], STOPS[i + 1], t - i)


def icon(size):
    s = size * 4
    img = Image.new("RGB", (s, s))
    px = img.load()
    for y in range(s):
        for x in range(s):
            px[x, y] = gradient((x * 0.35 + (s - y) * 0.65) / s)
    d = ImageDraw.Draw(img)
    w = int(s * 0.07)
    m = int(s * 0.22)
    d.rounded_rectangle((m, m, s - m, s - m), radius=int(s * 0.17), outline="white", width=w)
    r = int(s * 0.14)
    c = s // 2
    d.ellipse((c - r, c - r, c + r, c + r), outline="white", width=w)
    dr = int(s * 0.035)
    dx, dy = int(s * 0.665), int(s * 0.335)
    d.ellipse((dx - dr, dy - dr, dx + dr, dy + dr), fill="white")
    return img.resize((size, size), Image.LANCZOS)


for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
    icon(size).save(OUT / name)
    print("wrote", name)
