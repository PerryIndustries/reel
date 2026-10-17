"""Draw the home-screen icons for Thread (docs/r) and Wire (docs/x): original marks, no platform logos.

Thread: an orange rounded square with two looping thread lines.
Wire: a black rounded square with a single bright wire bending through it and a spark at its end.
"""

from pathlib import Path

from PIL import Image, ImageDraw

DOCS = Path(__file__).resolve().parent.parent / "docs"


def thread_icon(size):
    s = size * 4
    img = Image.new("RGB", (s, s), (255, 69, 0))
    d = ImageDraw.Draw(img)
    w = int(s * 0.075)
    for y0, alpha in ((0.42, 255), (0.68, 150)):
        pts = []
        for k in range(0, 101):
            t = k / 100
            x = s * (0.14 + 0.72 * t)
            # three gentle loops across the square
            import math

            y = s * y0 - s * 0.09 * math.sin(t * math.pi * 3)
            pts.append((x, y))
        col = (255, 255, 255) if alpha == 255 else (255, 210, 190)
        d.line(pts, fill=col, width=w, joint="curve")
        r = w // 2
        for x, y in (pts[0], pts[-1]):
            d.ellipse((x - r, y - r, x + r, y + r), fill=col)
    return img.resize((size, size), Image.LANCZOS)


def wire_icon(size):
    import math

    s = size * 4
    img = Image.new("RGB", (s, s), (0, 0, 0))
    d = ImageDraw.Draw(img)
    w = int(s * 0.07)
    pts = []
    for k in range(0, 101):
        t = k / 100
        x = s * (0.16 + 0.68 * t)
        y = s * (0.72 - 0.44 * t) + s * 0.06 * math.sin(t * math.pi * 2)
        pts.append((x, y))
    d.line(pts, fill=(29, 155, 240), width=w, joint="curve")
    r = w // 2
    d.ellipse((pts[0][0] - r, pts[0][1] - r, pts[0][0] + r, pts[0][1] + r), fill=(29, 155, 240))
    # the spark at the live end
    x, y = pts[-1]
    sr = int(s * 0.085)
    d.ellipse((x - sr, y - sr, x + sr, y + sr), fill=(255, 255, 255))
    for ang in range(0, 360, 45):
        a = math.radians(ang)
        d.line((x + math.cos(a) * sr * 1.3, y + math.sin(a) * sr * 1.3, x + math.cos(a) * sr * 2.1, y + math.sin(a) * sr * 2.1), fill=(255, 255, 255), width=int(s * 0.022))
    return img.resize((size, size), Image.LANCZOS)


for folder, fn in (("r", thread_icon), ("x", wire_icon)):
    out = DOCS / folder
    out.mkdir(parents=True, exist_ok=True)
    for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
        fn(size).save(out / name)
        print("wrote", folder + "/" + name)
