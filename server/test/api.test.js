// The phone-facing API over HTTP: cards, feed paging, profile, comments, stories, activity, votes, switches.
// Real engine on a temp data dir and a random port; rows are inserted straight into its db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEngine, getJson, postJson } from './helpers.js';
import { makeTargets, countsAt } from '../lib/engagement.js';
import { card } from '../lib/cards.js';

const H = 3600_000;
const D = 24 * H;

async function engine(t) {
  const e = await startTestEngine();
  t.after(() => e.stop());
  // a clean slate: the engine seeds its own accounts at boot
  for (const tbl of ['posts', 'items', 'comments', 'activity', 'convos', 'dms', 'accounts', 'writer_jobs']) e.ctx.db.exec(`DELETE FROM ${tbl}`);
  return e;
}

function addAcct(ctx, id, { own = false, pfp = '', followers = 5000 } = {}) {
  ctx.db.prepare('INSERT INTO accounts(id, own, handle, name, bio, pfp, settings, created_at, followers, quiet, seed) VALUES (?,?,?,?,?,?,?,?,?,0,?)')
    .run(id, own ? 1 : 0, 'h_' + id, 'Name ' + id, 'bio ' + id, pfp, '{}', Date.now() - 30 * D, followers, id.length * 31 + 7);
}

function addItem(ctx, key, { kind = 'photo', w = 1080, h = 1350, dur = null } = {}) {
  ctx.db.prepare('INSERT INTO items(key, path, folder, kind, w, h, dur, derived, gone, added_at) VALUES (?,?,?,?,?,?,?,1,0,?)')
    .run(key, `f/${key}`, 'f', kind, w, h, dur, Date.now() - D);
}

let seq = 100;
// A live post up `ageH` hours ago with real targets, so countsAt is non-trivial.
function addPost(ctx, { id, acct, keys, kind = 'post', ageH = 30, status = 'live', pinned = 0, liked = 0, storyText = null, highlight = 0 }) {
  const upAt = Date.now() - ageH * H;
  const a = ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(acct);
  const post = { id, kind, seed: seq++, up_at: upAt };
  const targets = JSON.stringify({ ...makeTargets(post, a), act: { l: 0, c: 0, f: 0 } });
  ctx.db.prepare(`INSERT INTO posts(id, acct, items, kind, caption, status, due_at, up_at, targets, liked, saved, pinned, seed, story_text, highlight, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`)
    .run(id, acct, JSON.stringify(keys), kind, 'caption ' + id, status, upAt, status === 'queued' ? null : upAt, targets, liked, pinned, post.seed, storyText, highlight, upAt);
  return ctx.db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
}

function addComments(ctx, post, n, { fromH = 29 } = {}) {
  const ins = ctx.db.prepare('INSERT INTO comments(post, author, author_pfp, text, at, owner_reply, mine) VALUES (?,?,?,?,?,0,0)');
  for (let i = 0; i < n; i++) ins.run(post.id, `fan${i}`, 'pfp/r00.jpg', `comment ${i}`, Date.now() - (fromH - i * 0.01) * H);
}

test('card shape: relative media URLs, top at most 4, counts from countsAt', async (t) => {
  const e = await engine(t);
  const { ctx } = e;
  addAcct(ctx, 'a1', { own: true, pfp: 'pfp/r002.jpg' });
  addItem(ctx, 'p:1#2', { kind: 'photo' });
  addItem(ctx, 'v1', { kind: 'video', w: 720, h: 1280, dur: 12.5 });
  const post = addPost(ctx, { id: 'c1', acct: 'a1', keys: ['p:1#2', 'v1'], ageH: 60 });
  addComments(ctx, post, 12, { fromH: 55 });
  const now = Date.now();
  const c = card(ctx, ctx.db.prepare('SELECT * FROM posts WHERE id = ?').get('c1'), now);
  assert.deepEqual(c.acct, { id: 'a1', handle: 'h_a1', name: 'Name a1', pfp: 'pfp/r002.jpg', own: true });
  assert.equal(c.kind, 'post');
  assert.equal(c.caption, 'caption c1');
  assert.deepEqual(c.media[0], {
    kind: 'photo', item: 'p:1#2', thumb: 'media/p_1_2/thumb.jpg', full: 'media/p_1_2/full.jpg',
    video: null, poster: null, w: 1080, h: 1350, dur: null,
  });
  assert.deepEqual(c.media[1], {
    kind: 'video', item: 'v1', thumb: 'media/v1/thumb.jpg', full: null,
    video: 'media/v1/video.mp4', poster: 'media/v1/poster.jpg', w: 720, h: 1280, dur: 12.5,
  });
  for (const m of c.media) for (const u of [m.thumb, m.full, m.video, m.poster]) {
    if (u != null) assert.ok(u.startsWith('media/') && !/^[a-z]+:|^\//.test(u), `not relative: ${u}`);
  }
  const post0 = ctx.db.prepare('SELECT * FROM posts WHERE id = ?').get('c1');
  const expect = countsAt(post0, now, 12);
  assert.equal(c.likes, expect.likes);
  assert.equal(c.comments, expect.comments);
  assert.ok(c.comments > 4);
  assert.equal(c.top.length, 4);
  assert.deepEqual(Object.keys(c.top[0]).sort(), ['at', 'author', 'text']);
  assert.equal(c.top[0].author.handle, 'fan' + (c.comments - 4));
  assert.equal(c.at, post0.up_at);
  assert.deepEqual([c.liked, c.saved, c.pinned], [false, false, false]);
});

test('feed pages 8 cards, continues by stream+cursor, and an unknown stream starts over', async (t) => {
  const e = await engine(t);
  const { ctx, base } = e;
  for (let a = 0; a < 5; a++) {
    addAcct(ctx, `a${a}`);
    for (let i = 0; i < 6; i++) { addItem(ctx, `k${a}_${i}`); addPost(ctx, { id: `p${a}_${i}`, acct: `a${a}`, keys: [`k${a}_${i}`] }); }
  }
  const r1 = await getJson(`${base}/reel/api/feed`);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.cards.length, 8);
  assert.ok(r1.body.stream && r1.body.cursor);
  const r2 = await getJson(`${base}/reel/api/feed?stream=${r1.body.stream}&cursor=${r1.body.cursor}`);
  assert.equal(r2.body.stream, r1.body.stream);
  const ids1 = new Set(r1.body.cards.map((c) => c.id));
  assert.ok(r2.body.cards.length > 0 && r2.body.cards.every((c) => !ids1.has(c.id)));
  const r3 = await getJson(`${base}/reel/api/feed?stream=gone&cursor=8`);
  assert.equal(r3.status, 200);
  assert.notEqual(r3.body.stream, 'gone');
  assert.equal(r3.body.cards.length, 8);
  for (const path of ['reels', 'explore']) assert.equal((await getJson(`${base}/reel/api/${path}`)).status, 200);
});

test('GET acct/:id is the profile page next to the PUT/DELETE routes of accounts.js', async (t) => {
  const e = await engine(t);
  const { ctx, base } = e;
  addAcct(ctx, 'a1', { own: true });
  addAcct(ctx, 'a2');
  for (let i = 0; i < 10; i++) { addItem(ctx, `k${i}`); addPost(ctx, { id: `p${i}`, acct: 'a1', keys: [`k${i}`], ageH: 5 + i, pinned: i === 2 ? 1 : 0 }); }
  addItem(ctx, 'z'); addPost(ctx, { id: 'z', acct: 'a2', keys: ['z'] });
  const r = await getJson(`${base}/reel/api/acct/a1`);
  assert.equal(r.status, 200);
  assert.equal(r.body.acct.id, 'a1');
  assert.equal(r.body.acct.bio, 'bio a1');
  assert.equal(r.body.acct.posts, 10);
  assert.ok(r.body.acct.followers >= 5000);
  assert.equal(typeof r.body.acct.following, 'number');
  assert.deepEqual(r.body.pinned.map((c) => c.id), ['p2']);
  assert.deepEqual(r.body.page.cards.map((c) => c.id), ['p0', 'p1', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
  const next = await getJson(`${base}/reel/api/acct/a1?stream=${r.body.page.stream}&cursor=${r.body.page.cursor}`);
  assert.deepEqual(next.body.page.cards.map((c) => c.id), ['p9']);
  assert.equal(next.body.page.cursor, null);
  assert.equal((await getJson(`${base}/reel/api/acct/nope`)).status, 404);
  assert.equal((await postJson(`${base}/reel/api/acct/a2`, { bio: 'changed' }, 'PUT')).status, 200);
  assert.equal((await getJson(`${base}/reel/api/acct/a2`)).body.acct.bio, 'changed');
});


test('post/:id and its comments: only the landed ones, your own comment shows at once, 30 per page', async (t) => {
  const e = await engine(t);
  const { ctx, base } = e;
  addAcct(ctx, 'a1', { own: true });
  addAcct(ctx, 'a2');
  addItem(ctx, 'k');
  const post = addPost(ctx, { id: 'p1', acct: 'a2', keys: ['k'], ageH: 47 });
  const cnt = JSON.parse(post.targets).comments;
  addComments(ctx, post, cnt, { fromH: 46.9 });
  ctx.db.prepare('INSERT INTO comments(post, author, author_pfp, text, at, owner_reply, mine) VALUES (?,?,?,?,?,0,0)')
    .run('p1', 'future', '', 'not yet', Date.now() + H);
  const r = await getJson(`${base}/reel/api/post/p1`);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, 'p1');
  assert.equal(r.body.comments.length, cnt);
  assert.ok(!r.body.comments.some((c) => c.text === 'not yet'));
  assert.equal(r.body.comments.at(-1).text, `comment ${cnt - 1}`, 'newest last');

  assert.equal((await postJson(`${base}/reel/api/comment`, { post: 'p1', text: '   ' })).status, 400);
  assert.equal((await postJson(`${base}/reel/api/comment`, { post: 'nope', text: 'hi' })).status, 404);
  for (let i = 0; i < 35; i++) assert.deepEqual((await postJson(`${base}/reel/api/comment`, { post: 'p1', text: `mine ${i}` })).body, { ok: true });
  const after = await getJson(`${base}/reel/api/post/p1`);
  assert.equal(after.body.comments.length, cnt + 35);
  assert.equal(after.body.comments.at(-1).text, 'mine 34');
  assert.equal(after.body.comments.at(-1).author.id, 'a1', 'written as your own account');
  assert.equal(after.body.top.length, 4);
  const p1 = await getJson(`${base}/reel/api/post/p1/comments`);
  assert.equal(p1.body.comments.length, 30);
  assert.equal(p1.body.cursor, '30');
  const p2 = await getJson(`${base}/reel/api/post/p1/comments?cursor=${p1.body.cursor}`);
  assert.equal(p2.body.comments.length, cnt + 35 - 30);
  assert.equal(p2.body.cursor, null);
});

test('taste up/down/undo, seen, and the like/save/pin switches', async (t) => {
  const e = await engine(t);
  const { ctx, base } = e;
  addAcct(ctx, 'a1', { own: true });
  addItem(ctx, 'k');
  addPost(ctx, { id: 'p1', acct: 'a1', keys: ['k'] });
  const item = () => ctx.db.prepare('SELECT up, down, seen_at FROM items WHERE key = ?').get('k');
  const vote = (v) => postJson(`${base}/reel/api/taste`, { item: 'k', vote: v });
  assert.deepEqual((await vote('up')).body, { ok: true });
  await vote('up');
  assert.equal(item().up, 2);
  await vote('undo');
  assert.equal(item().up, 1, 'undo reverts only the last vote');
  await vote('undo');
  assert.equal(item().up, 1, 'a second undo does nothing');
  await vote('down');
  assert.equal(item().down, 1);
  await vote('undo');
  assert.equal(item().down, 0);
  assert.equal((await vote('sideways')).status, 400);
  assert.equal((await postJson(`${base}/reel/api/taste`, { item: 'zzz', vote: 'up' })).status, 404);

  const before = Date.now();
  assert.deepEqual((await postJson(`${base}/reel/api/seen`, { items: ['k', 'unknown'] })).body, { ok: true });
  assert.ok(item().seen_at >= before);
  assert.equal((await postJson(`${base}/reel/api/seen`, { items: 'k' })).status, 400);

  for (const [route, col] of [['like', 'liked'], ['save', 'saved'], ['pin', 'pinned']]) {
    await postJson(`${base}/reel/api/${route}`, { post: 'p1', on: true });
    assert.equal(ctx.db.prepare('SELECT * FROM posts WHERE id = ?').get('p1')[col], 1, route);
    assert.equal((await getJson(`${base}/reel/api/post/p1`)).body[col === 'liked' ? 'liked' : col === 'saved' ? 'saved' : 'pinned'], true);
    await postJson(`${base}/reel/api/${route}`, { post: 'p1', on: false });
    assert.equal(ctx.db.prepare('SELECT * FROM posts WHERE id = ?').get('p1')[col], 0, route);
  }
  assert.equal((await postJson(`${base}/reel/api/like`, { post: 'nope', on: true })).status, 404);
  assert.equal((await postJson(`${base}/reel/api/like`, { post: 'p1' })).status, 400);
});

test('stories: live ones of the last 24 h, grouped by account, highlights and old ones left out', async (t) => {
  const e = await engine(t);
  const { ctx, base } = e;
  addAcct(ctx, 'a1', { own: true });
  addAcct(ctx, 'a2');
  for (const k of ['s1', 's2', 's3', 's4', 's5']) addItem(ctx, k);
  addItem(ctx, 'sv', { kind: 'video', dur: 5 });
  addPost(ctx, { id: 'st1', acct: 'a2', keys: ['s1'], kind: 'story', ageH: 3, storyText: 'hello' });
  addPost(ctx, { id: 'st2', acct: 'a2', keys: ['sv'], kind: 'story', ageH: 1, storyText: 'again' });
  addPost(ctx, { id: 'st3', acct: 'a1', keys: ['s2'], kind: 'story', ageH: 10 });
  addPost(ctx, { id: 'old', acct: 'a1', keys: ['s3'], kind: 'story', ageH: 30 });
  addPost(ctx, { id: 'hl', acct: 'a1', keys: ['s4'], kind: 'story', ageH: 5, highlight: 1 });
  addPost(ctx, { id: 'normal', acct: 'a1', keys: ['s5'] });
  const r = await getJson(`${base}/reel/api/stories`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((g) => g.acct.id), ['a1', 'a2'], 'your own account first');
  assert.deepEqual(r.body[0].items.map((i) => i.id), ['st3']);
  assert.deepEqual(r.body[1].items.map((i) => i.id), ['st1', 'st2'], 'oldest first inside a group');
  assert.equal(r.body[1].items[0].text, 'hello');
  assert.equal(r.body[1].items[1].media.kind, 'video');
  assert.equal(r.body[1].items[0].media.thumb, 'media/s1/thumb.jpg');
  assert.equal(typeof r.body[1].items[0].at, 'number');
});

test('activity is newest first, capped at 100, and a deleted account vanishes from every read', async (t) => {
  const e = await engine(t);
  const { ctx, base } = e;
  addAcct(ctx, 'a1', { own: true });
  addAcct(ctx, 'a2', { own: true });
  const ins = ctx.db.prepare('INSERT INTO activity(type, acct, who, who_pfp, post, text, at) VALUES (?,?,?,?,?,?,?)');
  for (let i = 0; i < 120; i++) ins.run(i % 3 === 0 ? 'comment' : 'like', i < 60 ? 'a1' : 'a2', `fan${i}`, 'pfp/r1.jpg', 'p', `t${i}`, Date.now() - 200 * 60_000 + i * 60_000);
  ins.run('follow', 'a1', 'later', '', 'p', '', Date.now() + H);
  let r = await getJson(`${base}/reel/api/activity`);
  assert.equal(r.body.length, 100);
  assert.equal(r.body[0].text, 't119');
  assert.deepEqual(Object.keys(r.body[0]).sort(), ['acct', 'at', 'post', 'text', 'type', 'who']);
  assert.equal(r.body[0].acct.id, 'a2');
  assert.deepEqual(r.body[0].who, { id: 'fan119', handle: 'fan119', name: '', pfp: 'pfp/r1.jpg', own: false });
  assert.ok(r.body.every((x, i) => i === 0 || r.body[i - 1].at >= x.at));
  assert.ok(!r.body.some((x) => x.who.handle === 'later'));

  addItem(ctx, 'k');
  addPost(ctx, { id: 'p1', acct: 'a1', keys: ['k'] });
  addAcct(ctx, 'a3');
  addItem(ctx, 'k3');
  addPost(ctx, { id: 'p3', acct: 'a3', keys: ['k3'] });
  assert.equal((await getJson(`${base}/reel/api/post/p3`)).status, 200);
  ctx.db.prepare('DELETE FROM accounts WHERE id = ?').run('a3');
  assert.equal((await getJson(`${base}/reel/api/post/p3`)).status, 404);
  assert.ok(!(await getJson(`${base}/reel/api/feed`)).body.cards.some((c) => c.id === 'p3'));
  ctx.db.prepare('DELETE FROM accounts WHERE id = ?').run('a2');
  r = await getJson(`${base}/reel/api/activity`);
  assert.ok(r.body.every((x) => x.acct.id === 'a1'));
});
