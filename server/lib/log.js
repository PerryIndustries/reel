// Append-only line log with size rotation: <name>, <name>.1 (newest) ... <name>.<keep> (oldest).
import fs from 'node:fs';
import path from 'node:path';

const MB = 1024 * 1024;

// makeLog(logDir, {name, maxBytes, keep}) -> log(level, msg, extra?)
// A line is `<ISO time> <level> <msg>[ <extra JSON>]`. Logging never throws.
export function makeLog(logDir, { name = 'engine.log', maxBytes = 20 * MB, keep = 3 } = {}) {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, name);
  let size = 0;
  try { size = fs.statSync(file).size; } catch { size = 0; }

  function rotate() {
    // shift every rotated file up one, the live file becomes .1, then drop whatever passed `keep`
    for (let i = keep; i >= 1; i--) {
      const src = `${file}.${i}`;
      if (fs.existsSync(src)) fs.renameSync(src, `${file}.${i + 1}`);
    }
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
    fs.rmSync(`${file}.${keep + 1}`, { force: true });
    size = 0;
  }

  function log(level, msg, extra) {
    try {
      let line = `${new Date().toISOString()} ${level} ${msg}`;
      if (extra !== undefined) {
        let ex;
        try { ex = JSON.stringify(extra, errorReplacer); } catch { ex = String(extra); }
        line += ` ${ex}`;
      }
      line += '\n';
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) rotate();
      fs.appendFileSync(file, line);
      size += bytes;
    } catch {
      // a broken log must never take the engine down
    }
  }
  log.file = file;
  return log;
}

function errorReplacer(key, value) {
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  return value;
}
