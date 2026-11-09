// 一度開いたら、ネットにつながらなくても開けるようにする(ファイルを iPad に取っておく)
const CACHE = "pad-v1";
const FILES = ["./", "index.html", "rtc.js", "vendor/qrcode.js", "vendor/jsQR.js", "manifest.json"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
// ネットが使えれば新しい方、使えなければ取っておいた方
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((k) => k.put(e.request, c)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
