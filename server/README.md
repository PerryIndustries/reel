# reel-engine

The PC side of Reel: a Node service that keeps the library, the accounts, the schedule and the
writing on this PC and serves them to the phone app as JSON under `/reel/api/` and files under
`/reel/media/` (proxy.js forwards both prefixes untouched). Node 25 built-ins only, no npm install.

## Run

```
node server/run.js     # supervisor: starts main.js, restarts it on exit, restarts on a new git HEAD
node server/main.js    # the engine alone
```

- The engine binds `127.0.0.1` only. `GET http://127.0.0.1:11436/reel/api/status` shows its health.
- `run.js` refuses to start a second copy when the port already listens (prints and exits 0).
- Restart backoff: 2 s doubling to 60 s, reset after 10 min up. Every 2 min it checks
  `git rev-parse HEAD` of the checkout and restarts the engine when HEAD moved.
- The engine exits 1 on an uncaught exception; the supervisor brings it back.

## Environment

| Var | Default | What |
|---|---|---|
| `REEL_DATA` | `C:\Users\Perry\ReelLibrary` | data dir (layout below) |
| `REEL_PORT` | `11436` | listen port (`0` = random, tests) |
| `REEL_RCLONE` | `rclone` | rclone argv: a command, or a JSON array like `["node","fake-rclone.js"]` |
| `REEL_FFMPEG` | `ffmpeg` | ffmpeg argv (same forms) |
| `REEL_FFPROBE` | `ffprobe` | ffprobe argv (same forms) |
| `REEL_OLLAMA` | `http://127.0.0.1:11434` | Ollama base URL |
| `REEL_STYLE` | `C:\Users\Perry\ollama-proxy\reel-style.json` | writing style file |
| `REEL_SITE` | unset | local testing only: serve the app from this docs dir; never set in production |
| `REEL_TICK_MS` | `1000` | how often the tick loop looks for due ticks (tests use 10) |

## Data dir

```
<REEL_DATA>\
  source\              rclone mirror of the Drive folders
  derived\<slug>\      thumb.jpg, full.jpg / poster.jpg + video.mp4 per item (slug = key with # -> _)
  reel.db              SQLite (WAL); reel.db.bak.<yyyymmdd> nightly copies, newest 3 kept
  logs\engine.log      engine log, rotated at 20 MB x 3 (.1 newest .. .3 oldest)
  logs\supervisor.log  supervisor log (engine stdout/stderr lands here too)
```

## Code layout

- `main.js` builds `ctx = {cfg, db, log, state, router, ticks, hooks:{gone:[]}, rand}`, imports
  `lib/` modules in a fixed order (status, library, derive, accounts, scheduler, engagement, dms,
  writer, feed, api, media, importer) and calls each one's optional `start(ctx)`,
  `routes(router, ctx)` and, on shutdown, `stop(ctx)`.
- Ticks: push `{name, everyMs, fn(now)}` onto `ctx.ticks`; errors are logged, a tick never overlaps
  itself. Time-dependent functions take `now` as a parameter.
- Runtime facts for `status` go through `ctx.state` (`mirror`, `ollamaUp`, ...).
- New columns: `ensureColumn(db, table, col, type)` from the owning module's `start`; never edit
  the schema in `lib/db.js`.
- Router handlers are `(req, res, params, query, body)`; return a value to send it as 200 JSON, or
  write the response with `sendJson` / `sendError`; throw `HttpError(code, msg)` for 4xx. Anything
  else thrown answers 500 `{error}` and is logged.

## Tests

```
node --test "C:/Users/Perry/reel-wt/pc-engine/server/test/*.test.js"
```

(Node 25 does not expand a bare directory argument to `--test`, so pass the glob.) Every test uses
its own temp `REEL_DATA` and an engine on port 0 (`test/helpers.js`: `tempEnv`, `startTestEngine`,
`getJson`, `postJson`, `waitFor`); nothing touches the real data dir, Drive or Ollama.
