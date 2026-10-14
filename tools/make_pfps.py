"""Build the fake accounts' profile pictures in docs/pfp/ from the reviewed sources.

- s###.jpg: casual-selfie versions of the reviewed AI faces (f###.jpg): off-centre crops, a slight tilt,
  phone-style filters, grain and softness, so they stop looking like studio headshots.
- a###.jpg: AI-generated anime-style faces from thisanimedoesnotexist.ai.
  New anime faces must be reviewed by eye (remove anything childlike) before committing.

Usage: python tools/make_pfps.py selfies
       python tools/make_pfps.py anime <count>
       python tools/make_pfps.py index
"""

import io
import json
import random
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

OUT = Path(__file__).resolve().parent.parent / "docs" / "pfp"
SIZE = 160


def tint(im, r_add, b_add):
    r, g, b = im.split()
    return Image.merge("RGB", (r.point(lambda v: max(0, min(255, v + r_add))), g, b.point(lambda v: max(0, min(255, v + b_add)))))


def grain(im, amount, rnd):
    noise = Image.effect_noise(im.size, amount).convert("L")
    noise = ImageOps.autocontrast(noise)
    return Image.blend(im, Image.merge("RGB", (noise, noise, noise)), rnd.uniform(.04, .1))


def vignette(im, strength):
    w, h = im.size
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).ellipse((-w * .15, -h * .15, w * 1.15, h * 1.15), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(w * .18))
    dark = ImageEnhance.Brightness(im).enhance(1 - strength)
    return Image.composite(im, dark, mask)


def selfie(src, rnd):
    im = Image.open(src).convert("RGB")
    w = im.size[0]
    # off-centre crop: the face is rarely perfectly framed in a phone pic
    side = int(w * rnd.uniform(.7, .95))
    max_off = w - side
    cx = int(max_off / 2 + rnd.uniform(-.5, .5) * max_off)
    cy = int(max_off / 2 + rnd.uniform(-.35, .6) * max_off)
    im = im.crop((cx, cy, cx + side, cy + side)).resize((SIZE, SIZE), Image.LANCZOS)
    if rnd.random() < .35:
        im = im.rotate(rnd.uniform(-6, 6), resample=Image.BICUBIC, expand=False, fillcolor=(20, 20, 20))
        z = int(SIZE * .06)  # hide the rotated corners
        im = im.crop((z, z, SIZE - z, SIZE - z)).resize((SIZE, SIZE), Image.LANCZOS)
    if rnd.random() < .5:
        im = ImageOps.mirror(im)  # front cameras mirror
    look = rnd.choice(["moody", "moody", "warm", "bw", "film", "flash", "cool"])
    if look == "moody":
        im = ImageEnhance.Brightness(im).enhance(rnd.uniform(.55, .75))
        im = ImageEnhance.Contrast(im).enhance(rnd.uniform(1.15, 1.35))
        im = ImageEnhance.Color(im).enhance(rnd.uniform(.6, .85))
        im = tint(im, -6, 10)
        im = vignette(im, .45)
    elif look == "warm":
        im = ImageEnhance.Color(im).enhance(rnd.uniform(1.15, 1.35))
        im = tint(im, 18, -14)
        im = ImageEnhance.Brightness(im).enhance(rnd.uniform(.95, 1.1))
    elif look == "bw":
        im = ImageOps.grayscale(im).convert("RGB")
        im = ImageEnhance.Contrast(im).enhance(rnd.uniform(1.2, 1.5))
        im = vignette(im, .3)
    elif look == "film":
        im = ImageEnhance.Contrast(im).enhance(rnd.uniform(.72, .85))
        im = ImageEnhance.Brightness(im).enhance(rnd.uniform(1.05, 1.15))
        im = tint(im, 8, -4)
        im = im.point(lambda v: int(22 + v * .9))  # lifted blacks
    elif look == "flash":
        im = ImageEnhance.Brightness(im).enhance(rnd.uniform(1.1, 1.25))
        im = ImageEnhance.Contrast(im).enhance(rnd.uniform(1.3, 1.5))
        im = vignette(im, .6)
    else:  # cool
        im = tint(im, -12, 16)
        im = ImageEnhance.Color(im).enhance(rnd.uniform(.75, .95))
    if rnd.random() < .6:
        im = im.filter(ImageFilter.GaussianBlur(rnd.uniform(.3, .9)))
    im = grain(im, rnd.uniform(30, 60), rnd)
    return im, rnd.randint(52, 74)


def selfies():
    rnd = random.Random(2026)
    # full-frame sources (tools/raw_faces, not committed); faces removed in review stay removed
    faces = sorted((OUT.parent.parent / "tools" / "raw_faces").glob("r*.jpg"))
    for f in faces:
        im, q = selfie(f, rnd)
        im.save(OUT / ("s" + f.name[1:]), "JPEG", quality=q)
    print("selfies:", len(faces))


def anime(n):
    rnd = random.Random()
    have = len(list(OUT.glob("a*.jpg")))
    for i in range(have + 1, have + n + 1):
        seed = rnd.randint(0, 99999)
        psi = rnd.choice(["0.6", "0.7", "0.8"])
        url = f"https://thisanimedoesnotexist.ai/results/psi-{psi}/seed{seed:05d}.png"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (reel pfp fetch)"})
            data = urllib.request.urlopen(req, timeout=30).read()
            im = Image.open(io.BytesIO(data)).convert("RGB")
            w = im.size[0]
            c = int(w * .06)
            im = im.crop((c, c, w - c, w - c)).resize((SIZE, SIZE), Image.LANCZOS)
            im.save(OUT / f"a{i:03d}.jpg", "JPEG", quality=84)
        except Exception as e:
            print("anime", i, "failed", e, file=sys.stderr)
        time.sleep(.4)
    print("anime:", len(list(OUT.glob("a*.jpg"))))


def index():
    data = {"selfies": sorted(p.name for p in OUT.glob("s*.jpg")), "anime": sorted(p.name for p in OUT.glob("a*.jpg"))}
    (OUT / "index.json").write_text(json.dumps(data))
    print({k: len(v) for k, v in data.items()})


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "index"
    if cmd == "selfies":
        selfies()
    elif cmd == "anime":
        anime(int(sys.argv[2]) if len(sys.argv) > 2 else 120)
    else:
        index()
