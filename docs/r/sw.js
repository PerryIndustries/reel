// Offline support for Thread's shell. Posts and photos live in the app's own storage and in Reel's, not here.
const CACHE = "thread-v6";
const FILES = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png", "../kit/core.js", "../kit/base.css", "../pfp/index.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(FILES.map((f) => c.add(f).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // The fans' anime pictures never change, so keep a copy for offline use.
  if (new URL(req.url).origin === "https://s4.anilist.co"){
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  // Otherwise only the app's own files; Ollama on the owner's PC goes straight to the network.
  if (new URL(req.url).origin !== location.origin) return;
  // Videos from the PC folders stream straight from the PC (a cached copy breaks the Range requests they need).
  if (/\/pc\//.test(new URL(req.url).pathname)) return;
  e.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html")))
  );
});
