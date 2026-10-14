# Reel

A private photo feed for your phone. A bot posts from a Google Drive folder on a schedule; likes, comments, followers and the accounts behind them are simulated.

- App: `docs/` (served by GitHub Pages; add it to the iPhone home screen from Safari).
- Everything you post lives only on the phone (IndexedDB). The repo holds code only, never content.
- Drive access is read-only (`drive.readonly`), signed in with your own Google account.

## Drive folder rules
- Each photo or video in the folder is one post. A subfolder is one post with several photos.
- `name.txt` next to `name.jpg` is that post's caption (in a subfolder, any .txt file).
- `avatar.jpg` sets the profile photo, `bio.txt` sets the bio.

## Icons
`python tools/make_icons.py`

## Fake-account profile pictures
`docs/pfp/` holds the pictures: `f*.jpg` are AI-generated faces from thispersondoesnotexist.com (people who don't
exist), `p*.jpg` are free-license photos from Lorem Picsum (Unsplash). Every face was reviewed by eye and anything
that could pass for under 18 was removed. `python tools/fetch_pfps.py <faces> <photos>` adds more; review new faces
the same way before committing, then rebuild `docs/pfp/index.json`.
