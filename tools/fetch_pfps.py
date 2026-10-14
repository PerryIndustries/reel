"""Download the profile pictures for the app's fake accounts into docs/pfp/.

- f###.jpg: AI-generated faces from thispersondoesnotexist.com (people who don't exist).
- p###.jpg: free-license photos from Lorem Picsum (Unsplash images), for accounts whose
  picture is a view, a pet, a car or a thing rather than a face.

Each one is center-cropped to a square and shrunk to 160px so the whole set stays small.
Run again with a bigger count to add more; existing files are kept.
"""

import io
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "docs" / "pfp"
OUT.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (reel pfp fetch)"}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return r.read()


def save_square(data, path, crop, vary=False):
    im = Image.open(io.BytesIO(data)).convert("RGB")
    if vary:
        # phone-camera variety: a bit brighter/darker, warmer/cooler, punchier/flatter
        import random
        from PIL import ImageEnhance
        im = ImageEnhance.Brightness(im).enhance(random.uniform(.85, 1.12))
        im = ImageEnhance.Contrast(im).enhance(random.uniform(.88, 1.15))
        im = ImageEnhance.Color(im).enhance(random.uniform(.8, 1.2))
        r, g, b = im.split()
        warm = random.uniform(-10, 12)
        im = Image.merge("RGB", (r.point(lambda v: max(0, min(255, v + warm))), g, b.point(lambda v: max(0, min(255, v - warm)))))
    w, h = im.size
    side = int(min(w, h) * crop)
    left, top = (w - side) // 2, (h - side) // 2
    im = im.crop((left, top, left + side, top + side)).resize((160, 160), Image.LANCZOS)
    im.save(path, "JPEG", quality=82, optimize=True)


def faces(n):
    for i in range(1, n + 1):
        path = OUT / f"f{i:03d}.jpg"
        if path.exists():
            continue
        for attempt in range(3):
            try:
                # the faces sit mid-frame; trimming the edges hides most of the generator's background smears
                save_square(get("https://thispersondoesnotexist.com/random-person.jpeg?" + str(time.time())), path, 0.94, vary=True)
                break
            except Exception as e:  # network hiccup: wait and retry
                print("face", i, "retry", attempt, e, file=sys.stderr)
                time.sleep(3)
        time.sleep(1.2)  # same image is served within ~1s, and be polite
        print("face", i, flush=True)


def photos(n):
    import json
    ids = []
    page = 1
    while True:
        batch = json.loads(get(f"https://picsum.photos/v2/list?page={page}&limit=100"))
        if not batch:
            break
        ids += [b["id"] for b in batch]
        page += 1
        if page > 12:
            break
    import random
    random.Random(7).shuffle(ids)
    for i, pid in enumerate(ids[:n], start=1):
        path = OUT / f"p{i:03d}.jpg"
        if path.exists():
            continue
        try:
            save_square(get(f"https://picsum.photos/id/{pid}/400/400"), path, 1.0)
        except Exception as e:
            print("photo", pid, "failed", e, file=sys.stderr)
        print("photo", i, flush=True)


if __name__ == "__main__":
    n_faces = int(sys.argv[1]) if len(sys.argv) > 1 else 130
    n_photos = int(sys.argv[2]) if len(sys.argv) > 2 else 80
    faces(n_faces)
    photos(n_photos)
    print("faces:", len(list(OUT.glob("f*.jpg"))), "photos:", len(list(OUT.glob("p*.jpg"))))
