// iPad に取っておいたページだけを使う。自動では新しくしない(GitHub に勝手につながらない・中身が勝手に変わらない)。
// 新しい版にするのは、ページの「更新する」を押したときだけ(そのときはページが cache: "reload" で取り直して入れる)
const CACHE = "pad";
const FILES = ["./", "index.html", "rtclink.js", "vendor/qrcode.js", "vendor/jsQR.js", "manifest.json", "icon.png"];
self.addEventListener("install", (e) => {
  // 初めてのときだけ取っておく(sw.js が新しくなっても、取っておいたページは入れ替えない)
  e.waitUntil(caches.open(CACHE).then(async (c) => { if (!(await c.match("index.html"))) await c.addAll(FILES); }));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  // 「更新する」の取り直し・ほかのサイト・テストのページはそのまま
  if (e.request.method !== "GET" || e.request.cache === "reload" || u.origin !== location.origin || u.pathname.includes("/test/")) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request).then((res) => {
    if (res.ok) { const c = res.clone(); caches.open(CACHE).then((k) => k.put(e.request, c)); }
    return res;
  })));
});
