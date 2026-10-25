// Engine configuration from the environment. Every path the engine writes lives under dataDir.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DATA = 'C:\\Users\\Perry\\ReelLibrary';
const DEFAULT_PORT = 11436;

// An external-tool override: a JSON argv array (`["node","fake.js"]`), or a bare command name.
function argvFrom(value, dflt) {
  if (value == null || value === '') return dflt;
  const v = String(value).trim();
  if (v.startsWith('[')) {
    const arr = JSON.parse(v);
    if (!Array.isArray(arr) || arr.length === 0 || !arr.every((x) => typeof x === 'string')) {
      throw new Error(`argv override must be a non-empty JSON array of strings: ${v}`);
    }
    return arr;
  }
  return [v];
}

export function loadConfig(env = process.env) {
  const dataDir = env.REEL_DATA || DEFAULT_DATA;
  const port = env.REEL_PORT != null && env.REEL_PORT !== '' ? Number(env.REEL_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad REEL_PORT: ${env.REEL_PORT}`);
  const cfg = {
    dataDir,
    port,
    sourceDir: path.join(dataDir, 'source'),
    derivedDir: path.join(dataDir, 'derived'),
    dbPath: path.join(dataDir, 'reel.db'),
    logDir: path.join(dataDir, 'logs'),
    rclone: argvFrom(env.REEL_RCLONE, ['rclone']),
    ffmpeg: argvFrom(env.REEL_FFMPEG, ['ffmpeg']),
    ffprobe: argvFrom(env.REEL_FFPROBE, ['ffprobe']),
    ollama: env.REEL_OLLAMA || 'http://127.0.0.1:11434',
    stylePath: env.REEL_STYLE || 'C:\\Users\\Perry\\ollama-proxy\\reel-style.json',
    siteDir: env.REEL_SITE || null,
    // the reel checkout this engine runs from (server/lib/ -> repo root)
    repoDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  };
  for (const d of [cfg.dataDir, cfg.sourceDir, cfg.derivedDir, cfg.logDir]) fs.mkdirSync(d, { recursive: true });
  return cfg;
}
