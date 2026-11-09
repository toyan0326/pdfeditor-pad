// iPad 直接接続テスト
// パソコンと iPad を WebRTC で直接つなぐ。外のサーバー(STUN・TURN・伝言板)は一切使わない。
// 接続の情報(住所・合言葉・暗号の鍵の指紋)は QR コードで読み合う:
//   ① パソコンが QR を出す → ② iPad がカメラで読み、自分の QR を出す → ③ パソコンがカメラで読む
// パソコンの方から iPad に最初の通信を出すので、パソコンの受信を許可する必要がない。
"use strict";
const $ = (id) => document.getElementById(id);
const T0 = performance.now();
const log = (m) => {
  const t = ((performance.now() - T0) / 1000).toFixed(1);
  $("log").textContent += `[${t}s] ${m}\n`;
  $("log").scrollTop = $("log").scrollHeight;
};
const isPad = /iPad|iPhone|Android/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let role = null;     // "pc" | "pad"
let pc = null, ch = null, stream = null, scanTimer = 0, scanFn = null, failTimer = 0;
let localIps = [], remoteIps = [];
// iPad で開くページの場所(パソコンでファイルから開いたときも、iPad にはここを案内する)
const PAD_URL = location.protocol === "https:" ? location.href.split("#")[0].split("?")[0] : "https://toyan0326.github.io/pdfeditor-pad/";

// ---------- 状態の表示 ----------
function badge(text, cls) { const b = $("badge"); b.textContent = text; b.className = cls || ""; }
function step(text, hint) { $("step").textContent = text; $("step-hint").textContent = hint || ""; }
function show(id, on) { $(id).classList.toggle("hide", !on); }

// ---------- 接続の情報を短いコードにする ----------
// R1|役|ufrag|pwd|指紋(base64url)|住所~ポート,住所~ポート,...
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hexBytes = (h) => h.split(":").map((x) => parseInt(x, 16));
const bytesHex = (b) => Array.from(b, (x) => x.toString(16).toUpperCase().padStart(2, "0")).join(":");
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
  return ["R1", SETUP[setup] || "a", ufrag, pwd, b64u(hexBytes(fp[2])), cands.join(",")].join("|");
}
function parse(code) {
  const p = String(code).trim().split("|");
  if (p.length !== 6 || p[0] !== "R1") return null;
  return { setup: SETUP_R[p[1]], ufrag: p[2], pwd: p[3], fp: bytesHex(unb64u(p[4])), cands: p[5] ? p[5].split(",") : [] };
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
const ipsOf = (cands) => cands.map((c) => c.slice(0, c.lastIndexOf("~")));

// ---------- QR ----------
function qrSvg(text) {
  const q = qrcode(0, "M"); q.addData(text, "Byte"); q.make();
  return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}
function showQr(text) { $("qr").innerHTML = qrSvg(text); show("qr", true); $("code-out").value = text; }

// ---------- カメラ ----------
async function camOn() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("このブラウザではカメラが使えません（https で開いているか確かめてください）");
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: role === "pad" ? { ideal: "environment" } : "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  const v = $("video");
  v.srcObject = stream; v.classList.toggle("mirror", role === "pc");
  show("video", true);
  await v.play().catch(() => {});
  log("カメラ: " + (stream.getVideoTracks()[0]?.label || "on"));
}
function camOff() {
  clearTimeout(scanTimer); scanFn = null;
  stream?.getTracks().forEach((t) => t.stop()); stream = null;
  show("video", false);
}
// QR を読み続ける。fn が true を返したら止める
function scan(fn) {
  scanFn = fn;
  const v = $("video"), cv = document.createElement("canvas"), cx = cv.getContext("2d", { willReadFrequently: true });
  let busy = false;
  const tick = async () => {
    if (scanFn !== fn) return;
    if (!busy && v.videoWidth) {
      const w = Math.min(960, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth);
      cv.width = w; cv.height = h; cx.drawImage(v, 0, 0, w, h);
      const r = jsQR(cx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "attemptBoth" });
      if (r && r.data) {
        busy = true;
        try { if (await fn(r.data)) return; } catch (e) { log("× " + e.message); }
        busy = false;
      }
    }
    scanTimer = setTimeout(tick, 120);
  };
  tick();
}

// ---------- WebRTC ----------
function newPc() {
  // iceServers を空にして、外のサーバーへは何も出さない
  const p = new RTCPeerConnection({ iceServers: [] });
  p.addEventListener("iceconnectionstatechange", () => {
    log("ICE: " + p.iceConnectionState);
    if (p.iceConnectionState === "checking") { badge("つないでいます…", "wait"); armFail(20000); }
    if (p.iceConnectionState === "failed") fail("ICE が failed になりました");
    if (p.iceConnectionState === "disconnected") badge("途切れました", "ng");
  });
  p.addEventListener("connectionstatechange", () => log("接続: " + p.connectionState));
  return p;
}
function gathered(p, ms = 5000) {
  return new Promise((res) => {
    if (p.iceGatheringState === "complete") return res();
    const t = setTimeout(() => { log("住所集めを打ち切り"); res(); }, ms);
    p.addEventListener("icegatheringstatechange", () => { if (p.iceGatheringState === "complete") { clearTimeout(t); res(); } });
  });
}
function armFail(ms) { clearTimeout(failTimer); failTimer = setTimeout(() => { if (!ch || ch.readyState !== "open") fail(`${ms / 1000} 秒たってもつながりませんでした`); }, ms); }

function setIps() {
  $("ips").innerHTML = `<b>自分の住所</b><span>${localIps.join(", ") || "（なし）"}</span><b>相手の住所</b><span>${remoteIps.join(", ") || "（まだ）"}</span>`;
}

// ---------- 手順 ----------
async function startPc() {
  role = "pc"; enterRun();
  step("① カメラの使用を許可してください", "iPad の QR を読むのに使います。カメラを許可すると、社内での住所を相手に伝えられるようになります。");
  await camOn();
  pc = newPc();
  ch = pc.createDataChannel("t", { ordered: true }); wireChannel(ch);
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const code = pack(pc.localDescription.sdp);
  localIps = ipsOf(parse(code).cands); setIps();
  log("自分のコード: " + code.length + " 文字");
  showQr(code); $("qr").classList.add("small");
  step("② iPad でこのページを開き「iPad で始める」を押して、この QR を読んでください",
    "iPad に QR が出たら、それをこのパソコンのカメラに向けてください。");
  scan(async (txt) => {
    const info = parse(txt);
    if (!info || info.setup === "actpass") return false; // 自分のコードや別の QR は無視
    remoteIps = ipsOf(info.cands); setIps();
    log("iPad のコードを読みました");
    await pc.setRemoteDescription({ type: "answer", sdp: toSdp(info) });
    camOff(); show("qr", false);
    step("③ つないでいます…", "このパソコンから iPad に声をかけています。");
    badge("つないでいます…", "wait"); armFail(20000);
    return true;
  });
}

async function startPad() {
  role = "pad"; enterRun();
  step("① カメラの使用を許可してください", "パソコンの QR を読むのに使います。");
  await camOn();
  step("② パソコンに出ている QR にカメラを向けてください", "");
  scan(async (txt) => {
    const info = parse(txt);
    if (!info || info.setup !== "actpass") return false;
    remoteIps = ipsOf(info.cands); setIps();
    log("パソコンのコードを読みました");
    await answer(info);
    return true;
  });
}
async function answer(info) {
  pc = newPc();
  pc.addEventListener("datachannel", (e) => { ch = e.channel; wireChannel(ch); });
  await pc.setRemoteDescription({ type: "offer", sdp: toSdp(info) });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc); // カメラが動いている間に集める(Safari はその間だけ本当の住所を出す)
  const code = pack(pc.localDescription.sdp);
  localIps = ipsOf(parse(code).cands); setIps();
  camOff();
  showQr(code); $("qr").classList.remove("small");
  step("③ この QR を、パソコンのカメラに向けてください", "画面を明るくすると読みやすくなります。読めたら自動でつながります。");
}

// 貼ったコードで進める(カメラが使えないとき)
async function useCode(code) {
  const info = parse(code); if (!info) { log("× コードの形が違います"); return; }
  if (role === "pc" && scanFn) await scanFn(code);
  else if (role === "pad" && scanFn) await scanFn(code);
  else if (role === "pad" && !pc) await answer(info);
}

function enterRun() { show("choose", false); show("run", true); show("fail", false); show("done", false); badge("準備中", "wait"); }

// ---------- つながった後 ----------
let rtt = [];
function wireChannel(c) {
  c.onopen = async () => {
    clearTimeout(failTimer); camOff(); show("run", false); show("done", true); show("fail", false);
    badge("つながりました", "ok"); log("データの通り道が開きました");
    await describePair();
    if (role === "pc") pinger();
    sizeCanvas();
  };
  c.onclose = () => { badge("切れました", "ng"); log("切れました"); };
  c.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "ping") c.send(JSON.stringify({ t: "pong", ts: m.ts }));
    else if (m.t === "pong") { rtt.push(performance.now() - m.ts); if (rtt.length > 20) rtt.shift(); showRtt(); }
    else if (m.t === "d") drawRemote(m);
    else if (m.t === "clr") clearPad(false);
  };
}
function pinger() {
  const go = () => { if (ch?.readyState !== "open") return; ch.send(JSON.stringify({ t: "ping", ts: performance.now() })); setTimeout(go, 1000); };
  go();
}
function showRtt() {
  const el = document.getElementById("rtt"); if (!el) return;
  const s = [...rtt].sort((a, b) => a - b);
  el.textContent = `${s[Math.floor(s.length / 2)].toFixed(1)} ms（中央値・${s.length} 回）`;
}
async function describePair() {
  let txt = "（不明）";
  try {
    const st = await pc.getStats();
    let pair = null;
    st.forEach((r) => { if (r.type === "transport" && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId); });
    if (!pair) st.forEach((r) => { if (r.type === "candidate-pair" && (r.selected || r.nominated) && r.state === "succeeded") pair = pair || r; });
    if (pair) {
      const l = st.get(pair.localCandidateId), r = st.get(pair.remoteCandidateId);
      const a = (c) => c ? `${c.address || c.ip || "（隠れた住所）"}:${c.port}（${c.candidateType}）` : "?";
      txt = `${a(l)} ⇄ ${a(r)}`;
    }
  } catch (e) { log("統計が取れません: " + e.message); }
  $("pair").innerHTML = `<b>通り道</b><span>${txt}</span><b>外のサーバー</b><span>使っていません</span><b>暗号化</b><span>DTLS（鍵は QR で確認済み）</span>` +
    (role === "pc" ? `<b>往復の時間</b><span id="rtt">測っています…</span>` : "");
  log("通り道: " + txt);
}

// ---------- 書いて試す ----------
const cv = $("pad"), cx = cv.getContext("2d");
let last = null, lastR = null;
function sizeCanvas() {
  const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1;
  cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
  cx.setTransform(d, 0, 0, d, 0, 0); cx.lineCap = "round"; cx.lineJoin = "round";
}
function line(a, b, color) {
  const r = cv.getBoundingClientRect();
  cx.strokeStyle = color; cx.lineWidth = 2.5;
  cx.beginPath(); cx.moveTo(a.x * r.width, a.y * r.height); cx.lineTo(b.x * r.width, b.y * r.height); cx.stroke();
}
const norm = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
const send = (m) => { if (ch?.readyState === "open") ch.send(JSON.stringify(m)); };
cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); last = norm(e); send({ t: "d", k: 0, ...last }); });
cv.addEventListener("pointermove", (e) => {
  if (!last) return;
  for (const ev of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) {
    const p = norm(ev); line(last, p, "#1a4fd8"); send({ t: "d", k: 1, ...p }); last = p;
  }
});
const end = () => { if (last) send({ t: "d", k: 2 }); last = null; };
cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
function drawRemote(m) {
  if (m.k === 0) lastR = { x: m.x, y: m.y };
  else if (m.k === 1 && lastR) { const p = { x: m.x, y: m.y }; line(lastR, p, "#d8331a"); lastR = p; }
  else lastR = null;
}
function clearPad(tell) { cx.clearRect(0, 0, cv.width, cv.height); if (tell) send({ t: "clr" }); }
addEventListener("resize", () => { if (!$("done").classList.contains("hide")) sizeCanvas(); });

// ---------- うまくいかなかったとき ----------
function fail(why) {
  clearTimeout(failTimer);
  if (ch?.readyState === "open") return;
  log("× " + why);
  badge("つながりません", "ng"); show("fail", true);
  const v4 = (ips) => ips.filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  // パソコンの住所は隠れていてもよい(パソコンから声をかけるので)。iPad の住所が隠れているとつながらない
  const padIps = role === "pc" ? remoteIps : localIps;
  const mdns = padIps.some((ip) => ip.endsWith(".local"));
  const L = v4(localIps), R = v4(remoteIps);
  const same = L.some((a) => R.some((b) => a.split(".").slice(0, 3).join(".") === b.split(".").slice(0, 3).join(".")));
  const items = [`理由: ${why}`, `自分の住所: ${localIps.join(", ") || "なし"} ／ 相手の住所: ${remoteIps.join(", ") || "なし"}`];
  if (mdns) items.push("iPad の住所が「…\.local」で隠れています。iPad でカメラを許可しないと本当の住所が出ません。カメラを許可してやり直してください。");
  if (!L.length || !R.length) items.push("どちらかの住所が取れていません。Wi-Fi（または有線）につながっているか確かめてください。");
  else if (!same) items.push("2 台の住所の始まりが違います。別々のネットワーク（例: パソコンは有線・iPad はゲスト用 Wi-Fi）にいる可能性があります。同じ Wi-Fi で試してください。");
  else items.push("同じネットワークにいるようですが、機器どうしの通信が止められている可能性があります（Wi-Fi の「クライアント分離」など）。この場合は、この方式ではつながりません。");
  $("diag").innerHTML = items.map((s) => `<li>${s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])}</li>`).join("");
  $("more").open = true;
}

// ---------- ボタン ----------
const guard = (f) => () => f().catch((e) => { log("× " + e.message); fail(e.name === "NotAllowedError" ? "カメラが許可されませんでした" : e.message); });
$("go-pc").onclick = guard(startPc);
$("go-pad").onclick = guard(startPad);
$("retry").onclick = () => location.reload();
$("clear").onclick = () => clearPad(true);
$("code-go").onclick = guard(() => useCode($("code-in").value));
(isPad ? $("go-pad") : $("go-pc")).classList.add("primary");
if (!isPad) {
  show("open-on-pad", true);
  $("url-qr").innerHTML = qrSvg(PAD_URL);
  $("pad-url").textContent = PAD_URL;
}
// iPad で一度開けば、次からはネットにつながらなくても開ける(会社の Wi-Fi で外のサイトが開けないとき用)
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch((e) => log("オフライン用の準備に失敗: " + e.message));
log(`開きました: ${isPad ? "iPad" : "パソコン"} / ${navigator.userAgent}`);
if (!window.isSecureContext) log("注意: https ではないのでカメラが使えません");
// テスト用
window.__rtc = { pack, parse, toSdp, qrSvg, useCode, state: () => ({ role, ice: pc?.iceConnectionState, ch: ch?.readyState, localIps, remoteIps }), send };
