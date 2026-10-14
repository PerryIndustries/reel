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
- A Drive subfolder named `pfps` (inside any of your folders) supplies most commenters' pictures. Never posted.
- Otherwise `docs/pfp/index.json` lists the built-ins:
  - `anime`: AniList character image links (loaded on the phone, not stored here). Picked from the most-favourited
    characters with gender "Male" and every listed age 18+, then reviewed by eye; anything that looked young or
    could read as female was dropped.
  - `photos`: `docs/pfp/r*.jpg`, free-license Lorem Picsum (Unsplash) photos, reviewed by eye so none has a person in it.
  - About 10% of accounts get the blank default silhouette.
- No photos of people are used.
