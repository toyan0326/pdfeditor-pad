// PC と iPad を WebRTC で直接つなぐ部品(PC のアプリと iPad のページの両方で使う)。
// - 外のサーバー(STUN・TURN・伝言板)は使わない(iceServers: [])。
// - 接続の情報(住所・合言葉・暗号の鍵の指紋)は QR をカメラで読み合って交換する:
//     PC が QR を出す → iPad が読んで自分の QR を出す → PC のカメラで読む
//   PC の方から iPad に最初の通信を出すので、PC の受信を許可しなくてよい(会社のファイアウォールでも通る)。
// - 中身は DTLS で暗号化される。鍵の指紋は QR で直接渡すので、間に入られない。
// - 大きなもの(ページの絵)は 16KB ずつに分けて送り、受け取った側でつなぎ直す。
"use strict";
const RtcLink = (() => {
  // ---------- 接続の情報を短いコードにする ----------
  // R1|役|ufrag|pwd|指紋(base64url)|住所~ポート,住所~ポート,...   役: x=申し込み(PC) a/p=返事(iPad)
  const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const SETUP = { actpass: "x", active: "a", passive: "p" };
  const SETUP_R = { x: "actpass", a: "active", p: "passive" };
  function pack(sdp) {
    const g = (re) => (sdp.match(re) || [])[1];
    const ufrag = g(/a=ice-ufrag:(\S+)/), pwd = g(/a=ice-pwd:(\S+)/), setup = g(/a=setup:(\S+)/);
    const fp = sdp.match(/a=fingerprint:(\S+) (\S+)/);
    if (!ufrag || !pwd || !fp || !setup) throw new Error("接続の情報を読み取れませんでした");
    if (fp[1].toLowerCase() !== "sha-256") throw new Error("想定外の鍵の種類: " + fp[1]);
    const cands = [];
    for (const line of sdp.split(/\r?\n/)) {
      const m = line.match(/^a=candidate:\S+ (\d) (\S+) \d+ (\S+) (\d+) typ (\S+)/);
      if (!m || m[1] !== "1" || m[2].toLowerCase() !== "udp") continue;
      const c = `${m[3]}~${m[4]}`;
      if (!cands.includes(c)) cands.push(c);
    }
    return ["R1", SETUP[setup] || "a", ufrag, pwd, b64u(fp[2].split(":").map((x) => parseInt(x, 16))), cands.join(",")].join("|");
  }
  function parse(code) {
    const s = String(code || "").trim();
    const p = s.slice(s.indexOf("R1|")).split("|");
    if (s.indexOf("R1|") < 0 || p.length !== 6) return null;
    try {
      const fp = Array.from(unb64u(p[4]), (x) => x.toString(16).toUpperCase().padStart(2, "0")).join(":");
      return { offer: p[1] === "x", setup: SETUP_R[p[1]], ufrag: p[2], pwd: p[3], fp, cands: p[5] ? p[5].split(",") : [] };
    } catch { return null; }
  }
  function toSdp(info) {
    const L = ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0", "a=msid-semantic: WMS",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0"];
    info.cands.forEach((c, i) => {
      const k = c.lastIndexOf("~");
      L.push(`a=candidate:${i + 1} 1 udp ${2122260223 - i} ${c.slice(0, k)} ${c.slice(k + 1)} typ host`);
    });
    // 住所が 1 つも無いとき(2 回目からの iPad)は「これで全部」と書かない。
    // 書かないと、PC から声がかかるのを待ち、声の来た所を相手の住所にする
    if (info.cands.length) L.push("a=end-of-candidates");
    L.push(`a=ice-ufrag:${info.ufrag}`, `a=ice-pwd:${info.pwd}`, "a=ice-options:trickle",
      `a=fingerprint:sha-256 ${info.fp}`, `a=setup:${info.setup}`, "a=mid:0", "a=sctp-port:5000", "a=max-message-size:262144");
    return L.join("\r\n") + "\r\n";
  }
  const ipsOf = (info) => info.cands.map((c) => c.slice(0, c.lastIndexOf("~")));

  function gathered(pc, ms = 5000) {
    return new Promise((res) => {
      if (pc.iceGatheringState === "complete") return res();
      const t = setTimeout(res, ms);
      pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); } });
    });
  }

  // ---------- 覚えておく鍵と合言葉(2 回目から QR 無しでつなぐため) ----------
  // 暗号の鍵(証明書)と、つなぐときの合言葉(ICE の ufrag/pwd)を毎回同じにする。
  // 相手の鍵の指紋と合言葉を覚えておけば、あとは iPad の「住所とポート」だけ分かればつなげる。
  // 鍵は相手の指紋と照らし合わせるので、同じ Wi-Fi のほかの機械がなりすますことはできない。
  function idb(name) {
    const open = () => new Promise((res, rej) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const op = async (mode, f) => {
      const d = await open();
      try {
        return await new Promise((res, rej) => {
          const t = d.transaction("kv", mode), q = f(t.objectStore("kv"));
          t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
        });
      } finally { d.close(); }
    };
    return {
      get: (k) => op("readonly", (s) => s.get(k)),
      put: (k, v) => op("readwrite", (s) => s.put(v, k)),
      del: (k) => op("readwrite", (s) => s.delete(k)),
    };
  }
  const ICE_CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randIce = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => ICE_CH[x % ICE_CH.length]).join("");
  const fpOfSdp = (sdp) => ((sdp.match(/a=fingerprint:sha-256 (\S+)/i) || [])[1] || "").toUpperCase();
  const YEAR = 365 * 24 * 3600 * 1000;
  // { cert, ufrag, pwd, fp, fresh }   fresh: 今回新しく作った(前の相手の覚えは使えない)
  const idCache = {};
  async function identity(dbName) {
    if (idCache[dbName]) return idCache[dbName];
    const db = idb(dbName);
    let id = null;
    try { id = await db.get("id"); } catch (e) { console.warn("identity", e); }
    // 期限の 1 週間前には作り直す(作り直すと、相手は QR でつなぎ直す)
    if (!id || !id.cert || !id.ufrag || !id.pwd || !id.fp || !(id.cert.expires > Date.now() + 7 * 24 * 3600 * 1000)) {
      const cert = await RTCPeerConnection.generateCertificate({ name: "ECDSA", namedCurve: "P-256", expires: YEAR });
      const pc = new RTCPeerConnection({ iceServers: [], certificates: [cert] });
      pc.createDataChannel("x");
      const fp = fpOfSdp((await pc.createOffer()).sdp); pc.close();
      id = { cert, ufrag: randIce(8), pwd: randIce(24), fp, at: Date.now() };
      try { await db.put("id", id); } catch (e) { console.warn("identity save", e); }
      id = { ...id, fresh: true };
    }
    return (idCache[dbName] = id);
  }
  const munge = (sdp, id) => id ? sdp.replace(/a=ice-ufrag:\S+/g, `a=ice-ufrag:${id.ufrag}`).replace(/a=ice-pwd:\S+/g, `a=ice-pwd:${id.pwd}`) : sdp;
  const newPeer = (id) => new RTCPeerConnection(id ? { iceServers: [], certificates: [id.cert] } : { iceServers: [] });
  // 覚えておく相手の情報(parse の結果から): 指紋・合言葉・役
  const peerOf = (info) => ({ fp: info.fp, ufrag: info.ufrag, pwd: info.pwd, setup: info.setup });

  // PC: 申し込みを作る。{ pc, dc, code }   id: identity() の結果(無ければ毎回ちがう鍵)
  async function offer(id) {
    const pc = newPeer(id);
    const dc = pc.createDataChannel("pad", { ordered: true });
    const o = await pc.createOffer();
    await pc.setLocalDescription({ type: "offer", sdp: munge(o.sdp, id) });
    await gathered(pc);
    return { pc, dc, code: pack(pc.localDescription.sdp) };
  }
  // PC: iPad の返事を受け取る
  async function accept(pc, info) { await pc.setRemoteDescription({ type: "answer", sdp: toSdp(info) }); }
  // iPad: 申し込みに返事をする。{ pc, code, info, channel: Promise<RTCDataChannel> }
  // 2 回目からは、覚えておいた PC の情報(住所なし)を申し込みとして渡す
  async function answer(info, id) {
    const pc = newPeer(id);
    const channel = new Promise((res) => pc.addEventListener("datachannel", (e) => res(e.channel)));
    await pc.setRemoteDescription({ type: "offer", sdp: toSdp(info) });
    const a = await pc.createAnswer();
    await pc.setLocalDescription({ type: "answer", sdp: munge(a.sdp, id) });
    await gathered(pc);
    const code = pack(pc.localDescription.sdp);
    return { pc, channel, code, info: parse(code) };
  }

  // ---------- 2 回目からの番号 ----------
  // iPad が出す番号: 前と同じ住所なら「ポート」だけ、住所の最後だけ変わったら「39-62003」、ちがう所なら「192.168.1.39:62003」
  const isV4 = (ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip);
  const pre24 = (ip) => ip.split(".").slice(0, 3).join(".");
  function numberFor(ip, port, lastIp) {
    if (!ip || (lastIp && ip === lastIp)) return String(port);
    if (lastIp && isV4(ip) && isV4(lastIp) && pre24(ip) === pre24(lastIp)) return `${ip.split(".")[3]}-${port}`;
    return `${ip}:${port}`;
  }
  // PC で打った番号を住所とポートにする。分からなければ null
  function readNumber(text, lastIp) {
    const s = String(text || "").trim().replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[\uFF0E\u3002]/g, ".").replace(/\uFF1A/g, ":").replace(/[\u30FC\uFF0D\u2015\u2010\u2212 \u3000]/g, "-");
    const okPort = (p) => p >= 1 && p <= 65535;
    let m = s.match(/^(\d{1,5})$/);
    if (m) return lastIp && okPort(+m[1]) ? { ip: lastIp, port: +m[1] } : null;
    m = s.match(/^(\d{1,3})-+(\d{1,5})$/);
    if (m) return lastIp && isV4(lastIp) && +m[1] <= 255 && okPort(+m[2]) ? { ip: `${pre24(lastIp)}.${+m[1]}`, port: +m[2] } : null;
    m = s.match(/^(\d+\.\d+\.\d+\.\d+)[:\-]+(\d{1,5})$/);
    if (m && m[1].split(".").every((x) => +x <= 255) && okPort(+m[2])) return { ip: m[1], port: +m[2] };
    return null;
  }
  // 返事の中から、PC が声をかける住所(IPv4 を先に)を選ぶ。{ ip, port } か null
  function mainCand(info) {
    const cs = (info && info.cands || []).map((c) => { const k = c.lastIndexOf("~"); return { ip: c.slice(0, k), port: +c.slice(k + 1) }; });
    return cs.find((c) => isV4(c.ip)) || cs.find((c) => !c.ip.endsWith(".local")) || cs[0] || null;
  }

  // ---------- 送り口(分けて送る・順番を守る・詰まったら待つ) ----------
  const CHUNK = 16000, HIGH = 1 << 20;
  function channel(dc, onMessage) {
    let q = [], pumping = false, seq = 0;
    const parts = new Map();
    dc.bufferedAmountLowThreshold = 256 * 1024;
    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        while (q.length && dc.readyState === "open") {
          if (dc.bufferedAmount > HIGH) await new Promise((r) => { const f = () => { dc.removeEventListener("bufferedamountlow", f); r(); }; dc.addEventListener("bufferedamountlow", f); setTimeout(f, 2000); });
          dc.send(q.shift());
        }
      } catch (e) { console.error(e); }
      finally { pumping = false; }
    }
    function send(m) {
      const s = typeof m === "string" ? m : JSON.stringify(m);
      if (dc.readyState !== "open") return false;
      if (s.length <= CHUNK) q.push(s);
      else {
        const id = ++seq, n = Math.ceil(s.length / CHUNK);
        for (let i = 0; i < n; i++) q.push(`\x01${id}|${i}|${n}|${s.slice(i * CHUNK, (i + 1) * CHUNK)}`);
      }
      pump();
      return true;
    }
    dc.addEventListener("message", (e) => {
      let s = e.data;
      if (typeof s !== "string") return;
      if (s.charCodeAt(0) === 1) {
        const a = s.indexOf("|"), b = s.indexOf("|", a + 1), c = s.indexOf("|", b + 1);
        const id = s.slice(1, a), i = +s.slice(a + 1, b), n = +s.slice(b + 1, c);
        let p = parts.get(id); if (!p) { p = { got: 0, arr: new Array(n) }; parts.set(id, p); }
        if (p.arr[i] == null) { p.arr[i] = s.slice(c + 1); p.got++; }
        if (p.got < n) return;
        parts.delete(id); s = p.arr.join("");
      }
      let m; try { m = JSON.parse(s); } catch { return; }
      onMessage(m);
    });
    return { send, get open() { return dc.readyState === "open"; }, close() { try { dc.close(); } catch {} } };
  }

  // ---------- カメラで QR を読む(jsQR が要る) ----------
  async function camera(video, facing) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("NO_CAMERA");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing === "environment" ? { ideal: "environment" } : "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    video.srcObject = stream; video.muted = true; video.playsInline = true;
    await video.play().catch(() => {});
    return { stop() { stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; } };
  }
  // 読めたら fn(文字列) を呼ぶ。fn が true を返したら止める。止める関数を返す
  function scan(video, fn) {
    let stopped = false, busy = false, timer = 0;
    const cv = document.createElement("canvas"), cx = cv.getContext("2d", { willReadFrequently: true });
    const tick = async () => {
      if (stopped) return;
      if (!busy && video.videoWidth && typeof jsQR === "function") {
        const w = Math.min(960, video.videoWidth), h = Math.round(video.videoHeight * w / video.videoWidth);
        cv.width = w; cv.height = h; cx.drawImage(video, 0, 0, w, h);
        const r = jsQR(cx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "attemptBoth" });
        if (r && r.data) {
          busy = true;
          try { if (await fn(r.data)) { stopped = true; return; } } catch (e) { console.error(e); }
          busy = false;
        }
      }
      timer = setTimeout(tick, 120);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }
  function loadScript(src) {
    return new Promise((res, rej) => {
      if ([...document.scripts].some((s) => s.src.endsWith(src))) return res();
      const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("読み込めません: " + src));
      document.head.appendChild(s);
    });
  }

  return { pack, parse, toSdp, ipsOf, offer, accept, answer, channel, camera, scan, loadScript,
    identity, idb, peerOf, numberFor, readNumber, mainCand, isV4 };
})();
if (typeof window !== "undefined") window.RtcLink = RtcLink;
