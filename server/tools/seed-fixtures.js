// Fills a REEL_DATA directory with a small made-up world for the phone check: 8 accounts, 300 posts of
// photos, videos and a few carousels, real tiny derivatives cut by ffmpeg (lavfi), comments, stories, activity
// and one DM chat. Never touches the real library, Drive or Ollama.
//   node server/tools/seed-fixtures.js <empty REEL_DATA dir>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.js';
import { makeTargets, commentTimes } from '../lib/engagement.js';
import { slug } from '../lib/derive.js';

const PFPS = ['r002.jpg', 'r003.jpg', 'r004.jpg', 'r005.jpg', 'r008.jpg', 'r010.jpg', 'r011.jpg', 'r013.jpg'].map((f) => `pfp/${f}`); // files in docs/pfp
const H = 3600_000;
const MIN = 60_000;

// small seeded generator (mulberry32) so a seeded world is the same every run
function rngOf(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', ...args], { windowsHide: true, timeout: 60_000 });
}

const COLORS = ['d94f4f', 'e0884a', 'd9c24f', '6cc24a', '3fb59a', '3f8fd9', '5a5ad9', '9a5ad9', 'd95ab0', '8a6a4a', '4a5a6a', 'c0c0c0'];
const SHAPES = [[360, 450], [360, 450], [360, 360], [450, 300]]; // portrait, portrait, square, landscape

// The shared pieces: 12 photo variants (thumb + full) and 4 videos (video + poster + thumb).
function makeBases(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const photos = COLORS.map((c, i) => {
    const [w, h] = SHAPES[i % SHAPES.length];
    const full = path.join(dir, `p${i}-full.jpg`);
    const thumb = path.join(dir, `p${i}-thumb.jpg`);
    const src = `color=c=0x${c}:s=${w}x${h},drawgrid=w=${Math.round(w / 6)}:h=${Math.round(h / 6)}:t=3:c=white@0.45,drawbox=x=${w / 3}:y=${h / 3}:w=${w / 3}:h=${h / 3}:c=black@0.35:t=fill`;
    ffmpeg(['-f', 'lavfi', '-i', src, '-frames:v', '1', '-q:v', '5', full]);
    ffmpeg(['-i', full, '-vf', `scale=${Math.round(w * 0.45)}:-2`, '-q:v', '6', thumb]);
    return { full, thumb, w, h };
  });
  const videos = [0, 1, 2, 3].map((i) => {
    const video = path.join(dir, `v${i}.mp4`);
    const poster = path.join(dir, `v${i}-poster.jpg`);
    const thumb = path.join(dir, `v${i}-thumb.jpg`);
    // silent audio track on purpose: test audio must be inaudible
    ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=180x320:r=10:d=1.5,hue=h=${i * 70}`, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-t', '1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '16k',
      '-movflags', '+faststart', video]);
    ffmpeg(['-i', video, '-frames:v', '1', '-q:v', '5', poster]);
    ffmpeg(['-i', poster, '-vf', 'scale=90:-2', '-q:v', '6', thumb]);
    return { video, poster, thumb, w: 180, h: 320, dur: 1.5 };
  });
  return { photos, videos };
}

const HANDLES = [
  ['yoru.exe', 'Yoru', 1], ['520le', '520le', 1], ['mochi.rx', 'Mochi', 1],
  ['nightcore.vx', 'Night', 0], ['zeroframe', 'Zero', 0], ['kitsune.dev', 'Kit', 0], ['halo_static', 'Halo', 0], ['ember.ix', 'Ember', 0],
];
const FANS = ['velvet_ghost', 'kai.0x', 'sorabyte', 'lunar.rin', 'vexel', 'notyourtype', 'dawn.exe', 'shadeclub', 'ryu_ix', 'onyx.nao'];
const CAPS = ['', '', 'sunday.', 'felt cute', 'photo dump nobody asked for', 'be honest', 'lighting did most of the work', 'anyway', 'no context', 'ok last one'];
const COMS = ['SIR', 'respectfully', 'the lighting', 'W post', 'obsessed', 'ate', 'pause', 'down bad rn', 'ok but who took this', 'i screamed', 'goals fr', 'help'];

export function seedFixtures(dataDir, { now = Date.now(), posts: nPosts = 300 } = {}) {
  const derived = path.join(dataDir, 'derived');
  fs.mkdirSync(derived, { recursive: true });
  const bases = makeBases(path.join(dataDir, 'seed-bases'));
  const db = openDb(path.join(dataDir, 'reel.db'));
  const r = rngOf(20261025);

  // accounts
  const accts = HANDLES.map(([handle, name, own], i) => {
    const id = (own ? 'a_seed' : 'n_seed') + i;
    const settings = { directions: { caption: '', comments: '', story: '', dmFan: '', dmMe: '' }, own: { captions: [], comments: [], stories: [] }, pronouns: 'she', heat: 'suggestive', multi: 'off' };
    const row = { id, own, handle, name, bio: own ? 'posting what i want' : 'your favorite distraction', pfp: i % 3 === 0 ? '' : PFPS[i % PFPS.length], settings: JSON.stringify(settings), created_at: now - 40 * 24 * H, followers: own ? 2400 + i * 900 : 1500 + i * 4000, quiet: 0, seed: 1000 + i };
    db.prepare('INSERT INTO accounts(id, own, handle, name, bio, pfp, settings, created_at, followers, quiet, seed) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.own, row.handle, row.name, row.bio, row.pfp, row.settings, row.created_at, row.followers, row.quiet, row.seed);
    return row;
  });

  // items: every post uses fresh items so slugs stay unique (carousels take 3 photos)
  const insItem = db.prepare(`INSERT INTO items(key, path, folder, drive_id, kind, w, h, dur, size, md5, parent, acct, derived, err, gone, added_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,1,NULL,0,?)`);
  let itemN = 0;
  const makeItem = (acct, kind) => {
    const key = `d_seed${String(itemN).padStart(4, '0')}`;
    const dir = path.join(derived, slug(key));
    fs.mkdirSync(dir, { recursive: true });
    let b;
    if (kind === 'video') {
      b = bases.videos[itemN % bases.videos.length];
      fs.copyFileSync(b.video, path.join(dir, 'video.mp4'));
      fs.copyFileSync(b.poster, path.join(dir, 'poster.jpg'));
      fs.copyFileSync(b.thumb, path.join(dir, 'thumb.jpg'));
    } else {
      b = bases.photos[itemN % bases.photos.length];
      fs.copyFileSync(b.full, path.join(dir, 'full.jpg'));
      fs.copyFileSync(b.thumb, path.join(dir, 'thumb.jpg'));
    }
    insItem.run(key, null, 'seed', key, kind, b.w, b.h, kind === 'video' ? b.dur : null, 1000, null, acct.id, now);
    itemN++;
    return key;
  };

  const insPost = db.prepare(`INSERT INTO posts(id, acct, items, kind, caption, status, due_at, up_at, down_at, targets, liked, saved, pinned, cycled, seed, story_text, highlight, created_at)
    VALUES (?,?,?,?,?,'live',?,?,NULL,?,0,0,?,0,?,'',0,?)`);
  const insCom = db.prepare('INSERT INTO comments(post, author, author_pfp, text, at, owner_reply, mine) VALUES (?,?,?,?,?,0,0)');
  const pinnedLeft = { a_seed0: 2 };
  const postRows = [];
  for (let k = 0; k < nPosts; k++) {
    const acct = accts[k % accts.length];
    const reel = k % 5 === 4; // 60 reels of 300
    const carousel = !reel && k % 37 === 11; // 8 carousels
    const keys = reel ? [makeItem(acct, 'video')] : carousel ? [makeItem(acct, 'photo'), makeItem(acct, 'photo'), makeItem(acct, 'photo')] : [makeItem(acct, 'photo')];
    const id = `p_seed${String(k).padStart(4, '0')}`;
    const upAt = now - (20 + k * 37) * MIN;
    const seed = Math.floor(r() * 2 ** 31);
    const post = { id, acct: acct.id, kind: reel ? 'reel' : 'post', seed, up_at: upAt, due_at: upAt, liked: 0 };
    const targets = makeTargets(post, { ...acct, settings: acct.settings });
    const pin = pinnedLeft[acct.id] > 0 && k >= 8 && k < 20 ? 1 : 0;
    if (pin) pinnedLeft[acct.id]--;
    insPost.run(id, acct.id, JSON.stringify(keys), post.kind, CAPS[k % CAPS.length], upAt, upAt, JSON.stringify(targets), pin, seed, upAt);
    const times = commentTimes(post, 12);
    for (let c = 0; c < 12; c++) {
      const fan = FANS[(k + c) % FANS.length];
      insCom.run(id, fan, c % 3 === 0 ? '' : PFPS[(c + k) % PFPS.length], COMS[(k * 3 + c) % COMS.length], times[c]);
    }
    postRows.push({ id, acct: acct.id, keys });
  }

  // stories: live within the last 24 h
  const insStory = db.prepare(`INSERT INTO posts(id, acct, items, kind, caption, status, due_at, up_at, down_at, targets, liked, saved, pinned, cycled, seed, story_text, highlight, created_at)
    VALUES (?,?,?,'story','','live',?,?,NULL,NULL,0,0,0,0,?,?,0,?)`);
  for (let s = 0; s < 6; s++) {
    const acct = accts[s % 4];
    const key = s === 5 ? makeItem(acct, 'video') : postRows[s * 7].keys[0];
    const at = now - (30 + s * 90) * MIN;
    insStory.run(`p_story${s}`, acct.id, JSON.stringify([key]), at, at, 500 + s, ['who is up', 'dm me', 'rate me 1-10', 'bored', 'good lighting', 'close friends only'][s], at);
  }

  // one DM chat with one unread fan message, and a few activity rows
  const own0 = accts[0].id;
  db.prepare('INSERT INTO convos(id, acct, fan, fan_handle, fan_pfp, state, next_at, unread) VALUES (?,?,?,?,?,?,NULL,1)')
    .run(`${own0}|velvet_ghost`, own0, 'velvet_ghost', 'velvet_ghost', 'pfp/r003.jpg', '{}');
  const insDm = db.prepare('INSERT INTO dms(convo, from_me, text, at, seen) VALUES (?,?,?,?,?)');
  insDm.run(`${own0}|velvet_ghost`, 0, 'ok be honest who took that pic', now - 50 * MIN, 1);
  insDm.run(`${own0}|velvet_ghost`, 1, 'lol you are bold', now - 40 * MIN, 1);
  insDm.run(`${own0}|velvet_ghost`, 0, 'so are you going to answer or', now - 8 * MIN, 0);
  const insAct = db.prepare('INSERT INTO activity(type, acct, who, who_pfp, post, text, at) VALUES (?,?,?,?,?,?,?)');
  insAct.run('comment', own0, 'kai.0x', 'pfp/r004.jpg', postRows[0].id, 'the lighting', now - 12 * MIN);
  insAct.run('like', own0, 'sorabyte', '', postRows[3].id, 'and 41 others', now - 2 * H);
  insAct.run('follow', own0, 'lunar.rin', 'pfp/r005.jpg', postRows[6].id, 'and 9 others', now - 5 * H);

  db.close();
  fs.rmSync(path.join(dataDir, 'seed-bases'), { recursive: true, force: true });
  return { accounts: accts.length, posts: nPosts, items: itemN, ownAccount: own0 };
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node seed-fixtures.js <REEL_DATA dir>'); process.exit(2); }
  console.log(JSON.stringify(seedFixtures(path.resolve(dir))));
}
