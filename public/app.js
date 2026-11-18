window.addEventListener("DOMContentLoaded", function () {
  const BORSA = document.body.getAttribute("data-exchange") || "bybit";
  let veri = null;

  const msg = document.getElementById("msgBox");
  const app = document.getElementById("app");
  const sel = document.getElementById("fCoin");
  const dStart = document.getElementById("dStart");
  const dEnd = document.getElementById("dEnd");
  const fRes = document.getElementById("fRes");

  async function yukle() {
    msg.style.display = "block";
    msg.textContent = "Veriler borsadan çekiliyor...";
    app.style.display = "none";

    try {
      const res = await fetch("/api/stats?exchange=" + BORSA + "&t=" + Date.now());
      if (!res.ok) throw new Error("Sunucu hatası: HTTP " + res.status);
      const json = await res.json();
      if (json.error) throw new Error(json.error);

      veri = json;
      const eski = sel.value;
      const coinSet = new Set();
      (veri.recentTrades || []).forEach(function (x) { coinSet.add(x.symbol); });
      const liste = Array.from(coinSet).sort();

      sel.innerHTML = '<option value="ALL">Tüm Pariteler (' + liste.length + ')</option>' +
        liste.map(function (c) { return '<option value="' + c + '">' + c + '</option>'; }).join("");
      if (liste.includes(eski)) sel.value = eski;

      ciz();
      msg.style.display = "none";
      app.style.display = "flex";
    } catch (err) {
      msg.innerHTML = '<span style="color:#f43f5e;">Hata: ' + err.message + '</span>';
    }
  }

  function tarihSec(tip, btn) {
    document.querySelectorAll(".rbtn").forEach(function (b) { b.classList.remove("active"); });
    if (btn) btn.classList.add("active");
    const bugun = new Date().toISOString().slice(0, 10);

    if (tip === "today") { dStart.value = bugun; dEnd.value = bugun; }
    else if (tip === "7d") { dStart.value = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10); dEnd.value = bugun; }
    else if (tip === "30d") { dStart.value = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10); dEnd.value = bugun; }
    else if (tip === "all") { dStart.value = ""; dEnd.value = ""; }
    ciz();
  }

  function ciz() {
    if (!veri) return;
    const sv = dStart.value;
    const ev = dEnd.value;
    const coin = sel.value;
    const resTip = fRes.value;

    const t1 = sv ? new Date(sv + "T00:00:00").getTime() : 0;
    const t2 = ev ? new Date(ev + "T23:59:59").getTime() : Infinity;

    const liste = (veri.recentTrades || []).filter(function (t) {
      if (t.time < t1 || t.time > t2) return false;
      if (coin !== "ALL" && t.symbol !== coin) return false;
      if (resTip === "WIN" && t.pnl <= 0) return false;
      if (resTip === "LOSS" && t.pnl >= 0) return false;
      return true;
    });

    let net = 0, gw = 0, gl = 0, wc = 0, lc = 0, mw = 0, ml = 0;
    const pMap = {};

    liste.forEach(function (t) {
      net += t.pnl;
      if (t.pnl > 0) { wc++; gw += t.pnl; if (t.pnl > mw) mw = t.pnl; }
      else if (t.pnl < 0) { lc++; gl += Math.abs(t.pnl); if (t.pnl < ml) ml = t.pnl; }

      if (!pMap[t.symbol]) pMap[t.symbol] = { s: t.symbol, c: 0, w: 0, p: 0 };
      pMap[t.symbol].c++;
      pMap[t.symbol].p += t.pnl;
      if (t.pnl > 0) pMap[t.symbol].w++;
    });

    const tot = wc + lc;
    const wr = tot ? ((wc / tot) * 100).toFixed(1) : "0.0";
    const pf = gl > 0 ? (gw / gl).toFixed(2) : (gw > 0 ? "∞" : "0.00");

    const elPnl = document.getElementById("kPnl");
    elPnl.textContent = (net >= 0 ? "+" : "") + net.toFixed(2) + " $";
    elPnl.className = "kv " + (net >= 0 ? "green" : "red");

    document.getElementById("kWin").textContent = "%" + wr;
    document.getElementById("kPf").textContent = pf;
    document.getElementById("kCnt").textContent = tot + " (" + wc + "K / " + lc + "Z)";
    document.getElementById("kAvg").innerHTML = '<span class="green">+' + (wc ? (gw / wc).toFixed(2) : "0.00") + '$</span> / <span class="red">-' + (lc ? (gl / lc).toFixed(2) : "0.00") + '$</span>';
    document.getElementById("kExt").innerHTML = '<span class="green">+' + mw.toFixed(2) + '$</span> / <span class="red">' + ml.toFixed(2) + '$</span>';

    const sirali = Object.values(pMap).sort(function (a, b) { return b.p - a.p; });
    document.getElementById("tPairs").innerHTML = sirali.length === 0
      ? '<tr><td colspan="4" style="text-align:center;color:#64748b;">Veri yok</td></tr>'
      : sirali.map(function (x) { return '<tr><td><strong>' + x.s + '</strong></td><td>' + x.c + '</td><td class="blue">%' + ((x.w / x.c) * 100).toFixed(0) + '</td><td style="text-align:right;" class="' + (x.p >= 0 ? 'green' : 'red') + '"><strong>' + (x.p >= 0 ? '+' : '') + x.p.toFixed(2) + '$</strong></td></tr>'; }).join("");

    document.getElementById("hCnt").textContent = liste.length + " İşlem";
    document.getElementById("tHist").innerHTML = liste.length === 0
      ? '<tr><td colspan="4" style="text-align:center;color:#64748b;">İşlem yok</td></tr>'
      : liste.map(function (t) { return '<tr><td><strong>' + t.symbol + '</strong></td><td style="color:#94a3b8;">' + new Date(t.time).toLocaleString("tr-TR") + '</td><td style="color:#94a3b8;">' + t.entryPrice + ' → ' + t.exitPrice + '</td><td style="text-align:right;" class="' + (t.pnl >= 0 ? 'green' : 'red') + '"><strong>' + (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2) + '$</strong></td></tr>'; }).join("");

    const acik = (veri.openPositions || []).filter(function (p) { return coin === "ALL" || p.symbol === coin; });
    document.getElementById("oCnt").textContent = acik.length + " Aktif";
    document.getElementById("tOpen").innerHTML = acik.length === 0
      ? '<tr><td colspan="6" style="text-align:center;color:#64748b;">Açık pozisyon yok</td></tr>'
      : acik.map(function (p) { return '<tr><td><strong>' + p.symbol + '</strong> <small style="color:#94a3b8;">' + p.leverage + 'x</small></td><td><span class="tag ' + (p.side === 'LONG' ? 'tlong' : 'tshort') + '">' + p.side + '</span></td><td>' + p.size + '</td><td>' + p.entryPrice + '</td><td>' + p.markPrice + '</td><td style="text-align:right;" class="' + (p.unrealizedPnl >= 0 ? 'green' : 'red') + '"><strong>' + (p.unrealizedPnl >= 0 ? '+' : '') + p.unrealizedPnl.toFixed(2) + '$</strong></td></tr>'; }).join("");

    grafikCiz(liste);
  }

  function grafikCiz(trades) {
    const box = document.getElementById("cBox");
    const badge = document.getElementById("cBadge");
    const sirali = trades.slice().sort(function (a, b) { return a.time - b.time; });

    if (sirali.length === 0) {
      badge.textContent = "0.00 $";
      box.innerHTML = '<span style="color:#64748b;font-size:12px;">Grafik verisi yok</span>';
      return;
    }

    let toplam = 0;
    const noktalar =;
    sirali.forEach(function (t) { toplam += t.pnl; noktalar.push(toplam); });

    badge.textContent = (toplam >= 0 ? "+" : "") + toplam.toFixed(2) + " $";
    badge.className = "tag " + (toplam >= 0 ? "tlong" : "tshort");

    const W = 600, H = 180, P = 15;
    const min = Math.min.apply(null, noktalar);
    const max = Math.max.apply(null, noktalar);
    const fark = (max - min) || 1;
    const pts = noktalar.map(function (v, i) {
      return (P + (i / (noktalar.length - 1)) * (W - P * 2)).toFixed(1) + "," + (H - P - ((v - min) / fark) * (H - P * 2)).toFixed(1);
    });
    const zY = (H - P - ((0 - min) / fark) * (H - P * 2)).toFixed(1);
    const renk = toplam >= 0 ? "#10b981" : "#f43f5e";

    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:100%;">' +
      '<line x1="' + P + '" y1="' + zY + '" x2="' + (W - P) + '" y2="' + zY + '" stroke="#334155" stroke-dasharray="4" stroke-width="1"/>' +
      '<polyline fill="none" stroke="' + renk + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="' + pts.join(" ") + '"/>' +
      '</svg>';
  }

  document.getElementById("refreshBtn").addEventListener("click", yukle);
  dStart.addEventListener("change", function () { tarihSec("custom", null); });
  dEnd.addEventListener("change", function () { tarihSec("custom", null); });
  sel.addEventListener("change", ciz);
  fRes.addEventListener("change", ciz);
  document.querySelectorAll(".rbtn").forEach(function (b) {
    b.addEventListener("click", function () { tarihSec(b.getAttribute("data-r"), b); });
  });

  yukle();
});
