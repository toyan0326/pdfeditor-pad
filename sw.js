// 一度開いたら、ネットにつながらなくても開けるようにする(ファイルを iPad に取っておく)
const CACHE = "pad-87c835b";
const FILES = ["./", "index.html", "rtclink.js", "vendor/qrcode.js", "vendor/jsQR.js", "manifest.json", "icon.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
// ネットが使えれば新しい方、使えなければ取っておいた方
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // ブラウザのキャッシュ(GitHub Pages は 10 分)を使わず、毎回新しいかを確かめる
  const same = new URL(e.request.url).origin === location.origin;
  e.respondWith(fetch(same ? new Request(e.request.url, { cache: "no-cache", credentials: "same-origin" }) : e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then((k) => k.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))));
});
