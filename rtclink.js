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
    L.push("a=end-of-candidates", `a=ice-ufrag:${info.ufrag}`, `a=ice-pwd:${info.pwd}`, "a=ice-options:trickle",
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
  const newPeer = () => new RTCPeerConnection({ iceServers: [] });

  // PC: 申し込みを作る。{ pc, dc, code }
  async function offer() {
    const pc = newPeer();
    const dc = pc.createDataChannel("pad", { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    return { pc, dc, code: pack(pc.localDescription.sdp) };
  }
  // PC: iPad の返事を受け取る
  async function accept(pc, info) { await pc.setRemoteDescription({ type: "answer", sdp: toSdp(info) }); }
  // iPad: 申し込みに返事をする。{ pc, code, channel: Promise<RTCDataChannel> }
  async function answer(info) {
    const pc = newPeer();
    const channel = new Promise((res) => pc.addEventListener("datachannel", (e) => res(e.channel)));
    await pc.setRemoteDescription({ type: "offer", sdp: toSdp(info) });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    return { pc, channel, code: pack(pc.localDescription.sdp) };
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

  return { pack, parse, toSdp, ipsOf, offer, accept, answer, channel, camera, scan, loadScript };
})();
if (typeof window !== "undefined") window.RtcLink = RtcLink;
