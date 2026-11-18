window.onload = function() {
  const borsa = document.body.dataset.exchange || "bybit";
  let db = null;
  const msg = document.getElementById("msg"), app = document.getElementById("app"), sel = document.getElementById("fCoin"), d1 = document.getElementById("dStart"), d2 = document.getElementById("dEnd"), resF = document.getElementById("fRes");

  async function load() {
    msg.style.display = "block"; msg.textContent = "Veriler yükleniyor..."; app.style.display = "none";
    try {
      const r = await fetch("/api/stats?exchange=" + borsa + "&t=" + Date.now());
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      db = j;
      const old = sel.value, s = new Set();
      (db.recentTrades || new Array()).forEach(function(x) { s.add(x.symbol); });
      const arr = Array.from(s).sort();
      sel.innerHTML = '<option value="ALL">Tüm Pariteler (' + arr.length + ')</option>' + arr.map(function(c) { return '<option value="' + c + '">' + c + '</option>'; }).join("");
      if (arr.includes(old)) sel.value = old;
      draw(); msg.style.display = "none"; app.style.display = "flex";
    } catch (e) { msg.innerHTML = '<span style="color:#f43f5e">Hata: ' + e.message + '</span>'; }
  }

  function setD(t, b) {
    document.querySelectorAll(".rb").forEach(function(x) { x.classList.remove("act"); });
    if (b) b.classList.add("act");
    const td = new Date().toISOString().slice(0, 10);
    if (t === "today") { d1.value = td; d2.value = td; }
    else if (t === "7d") { d1.value = new Date(Date.now() - 604800000).toISOString().slice(0, 10); d2.value = td; }
    else if (t === "30d") { d1.value = new Date(Date.now() - 2592000000).toISOString().slice(0, 10); d2.value = td; }
    else if (t === "all") { d1.value = ""; d2.value = ""; }
    draw();
  }

  function draw() {
    if (!db) return;
    const t1 = d1.value ? new Date(d1.value + "T00:00:00").getTime() : 0;
    const t2 = d2.value ? new Date(d2.value + "T23:59:59").getTime() : Infinity;
    const coin = sel.value, rf = resF.value;
    const list = (db.recentTrades || new Array()).filter(function(t) {
      return t.time >= t1 && t.time <= t2 && (coin === "ALL" || t.symbol === coin) && (rf === "ALL" || (rf === "WIN" && t.pnl > 0) || (rf === "LOSS" && t.pnl < 0));
    });

    let net = 0, gw = 0, gl = 0, wc = 0, lc = 0, mw = 0, ml = 0;
    const pm = {};
    list.forEach(function(t) {
      net += t.pnl;
      if (t.pnl > 0) { wc++; gw += t.pnl; if (t.pnl > mw) mw = t.pnl; }
      else if (t.pnl < 0) { lc++; gl += Math.abs(t.pnl); if (t.pnl < ml) ml = t.pnl; }
      if (!pm[t.symbol]) pm[t.symbol] = { s: t.symbol, c: 0, w: 0, p: 0 };
      pm[t.symbol].c++; pm[t.symbol].p += t.pnl; if (t.pnl > 0) pm[t.symbol].w++;
    });

    const tot = wc + lc, wr = tot ? ((wc / tot) * 100).toFixed(1) : "0.0", pf = gl > 0 ? (gw / gl).toFixed(2) : (gw > 0 ? "∞" : "0.00");
    const kp = document.getElementById("kPnl");
    kp.textContent = (net >= 0 ? "+" : "") + net.toFixed(2) + " $";
    kp.style.color = net >= 0 ? "#10b981" : "#f43f5e";
    document.getElementById("kWin").textContent = "%" + wr;
    document.getElementById("kPf").textContent = pf;
    document.getElementById("kCnt").textContent = tot + " (" + wc + "K/" + lc + "Z)";
    document.getElementById("kAvg").innerHTML = '<span style="color:#10b981">+' + (wc ? (gw/wc).toFixed(2) : "0.00") + '$</span> / <span style="color:#f43f5e">-' + (lc ? (gl/lc).toFixed(2) : "0.00") + '$</span>';
    document.getElementById("kExt").innerHTML = '<span style="color:#10b981">+' + mw.toFixed(2) + '$</span> / <span style="color:#f43f5e">' + ml.toFixed(2) + '$</span>';

    const sp = Object.values(pm).sort(function(a, b) { return b.p - a.p; });
    document.getElementById("tPairs").innerHTML = sp.length ? sp.map(function(x) { return '<tr><td><b>' + x.s + '</b></td><td>' + x.c + '</td><td style="color:#38bdf8">%' + ((x.w/x.c)*100).toFixed(0) + '</td><td style="text-align:right;color:' + (x.p>=0?'#10b981':'#f43f5e') + '"><b>' + (x.p>=0?'+':'') + x.p.toFixed(2) + '$</b></td></tr>'; }).join("") : '<tr><td colspan="4" style="text-align:center;color:#64748b">Veri yok</td></tr>';

    document.getElementById("hCnt").textContent = list.length + " İşlem";
    document.getElementById("tHist").innerHTML = list.length ? list.map(function(t) { return '<tr><td><b>' + t.symbol + '</b></td><td style="color:#94a3b8">' + new Date(t.time).toLocaleString("tr-TR") + '</td><td style="color:#94a3b8">' + t.entryPrice + ' → ' + t.exitPrice + '</td><td style="text-align:right;color:' + (t.pnl>=0?'#10b981':'#f43f5e') + '"><b>' + (t.pnl>=0?'+':'') + t.pnl.toFixed(2) + '$</b></td></tr>'; }).join("") : '<tr><td colspan="4" style="text-align:center;color:#64748b">İşlem yok</td></tr>';

    const op = (db.openPositions || new Array()).filter(function(p) { return coin === "ALL" || p.symbol === coin; });
    document.getElementById("oCnt").textContent = op.length + " Aktif";
    document.getElementById("tOpen").innerHTML = op.length ? op.map(function(p) { return '<tr><td><b>' + p.symbol + '</b> <small>' + p.leverage + 'x</small></td><td style="color:' + (p.side==='LONG'?'#10b981':'#f43f5e') + '"><b>' + p.side + '</b></td><td>' + p.size + '</td><td>' + p.entryPrice + '</td><td>' + p.markPrice + '</td><td style="text-align:right;color:' + (p.unrealizedPnl>=0?'#10b981':'#f43f5e') + '"><b>' + (p.unrealizedPnl>=0?'+':'') + p.unrealizedPnl.toFixed(2) + '$</b></td></tr>'; }).join("") : '<tr><td colspan="6" style="text-align:center;color:#64748b">Açık pozisyon yok</td></tr>';

    const box = document.getElementById("cBox"), bd = document.getElementById("cBadge");
    const ch = list.slice().sort(function(a, b) { return a.time - b.time; });
    if (!ch.length) { bd.textContent = "0.00 $"; box.innerHTML = '<span style="color:#64748b;font-size:12px">Veri yok</span>'; return; }
    let acc = 0; const vals = new Array(); vals.push(0);
    ch.forEach(function(t) { acc += t.pnl; vals.push(acc); });
    bd.textContent = (acc >= 0 ? "+" : "") + acc.toFixed(2) + " $";
    bd.style.color = acc >= 0 ? "#10b981" : "#f43f5e";
    const W = 600, H = 180, P = 15, mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals), df = (mx - mn) || 1;
    const pts = vals.map(function(v, i) { return (P + (i / (vals.length - 1)) * (W - P * 2)).toFixed(1) + "," + (H - P - ((v - mn) / df) * (H - P * 2)).toFixed(1); });
    const zy = (H - P - ((0 - mn) / df) * (H - P * 2)).toFixed(1);
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:100%"><line x1="' + P + '" y1="' + zy + '" x2="' + (W - P) + '" y2="' + zy + '" stroke="#334155" stroke-dasharray="4"/><polyline fill="none" stroke="' + (acc >= 0 ? "#10b981" : "#f43f5e") + '" stroke-width="3" points="' + pts.join(" ") + '"/></svg>';
  }

  document.getElementById("btnRef").onclick = load;
  d1.onchange = function() { setD("custom", null); };
  d2.onchange = function() { setD("custom", null); };
  sel.onchange = draw;
  resF.onchange = draw;
  document.querySelectorAll(".rb").forEach(function(b) { b.onclick = function() { setD(b.dataset.r, b); }; });
  load();
};
