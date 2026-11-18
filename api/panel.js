export default function handler(req, res) {
  const b = (req.query.b || "bybit").toLowerCase() === "binance" ? "binance" : "bybit";
  const isBinance = b === "binance";

  const title = isBinance ? "Binance Demo Pro Analiz" : "Bybit Demo Pro Analiz";
  const badge = isBinance ? "BINANCE FUTURES TESTNET" : "BYBIT DEMO TRADING";
  const otherLink = isBinance ? "/api/panel?b=bybit" : "/api/panel?b=binance";
  const otherText = isBinance ? "Bybit Paneline Geç →" : "Binance Paneline Geç →";
  const themeHex = isBinance ? "#FCD535" : "#F7A600";

  const html = `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <script src="https://tailwindcss.com"></script>
  <script src="https://jsdelivr.net"></script>
  <style>
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #090d16; }
    ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 4px; }
  </style>
</head>
<body class="bg-[#090d16] text-slate-100 min-h-screen p-4 md:p-6 font-sans">
  <div class="max-w-7xl mx-auto space-y-6">
    
    <!-- Üst Başlık ve Borsa Geçişi -->
    <div class="flex flex-col md:flex-row justify-between items-start md:items-center bg-slate-900/80 border border-slate-800/80 p-5 rounded-2xl gap-4">
      <div>
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full animate-pulse" style="background-color: ${themeHex}"></span>
          <span class="text-xs font-bold tracking-wider uppercase" style="color: ${themeHex}">${badge}</span>
        </div>
        <h1 class="text-2xl md:text-3xl font-extrabold mt-1 text-white tracking-tight">${title}</h1>
      </div>
      <div class="flex flex-wrap gap-3">
        <a href="${otherLink}" class="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-sm font-medium px-4 py-2.5 rounded-xl transition">${otherText}</a>
        <button onclick="fetchRawData()" class="text-slate-950 font-bold text-sm px-5 py-2.5 rounded-xl transition hover:opacity-90 shadow-lg" style="background-color: ${themeHex}">Verileri Yenile</button>
      </div>
    </div>

    <!-- Gelişmiş Filtre Çubuğu -->
    <div class="bg-slate-900/80 border border-slate-800/80 p-4 rounded-2xl flex flex-col lg:flex-row gap-4 justify-between items-stretch lg:items-center">
      <!-- Hızlı Tarih Butonları -->
      <div class="flex flex-wrap gap-2 items-center">
        <span class="text-xs text-slate-400 font-semibold uppercase mr-1">Dönem:</span>
        <button onclick="setQuickRange('today', this)" class="range-btn bg-slate-800 hover:bg-slate-700 text-xs font-medium px-3 py-2 rounded-lg transition">Bugün</button>
        <button onclick="setQuickRange('7d', this)" class="range-btn bg-slate-800 hover:bg-slate-700 text-xs font-medium px-3 py-2 rounded-lg transition">Son 7 Gün</button>
        <button onclick="setQuickRange('30d', this)" class="range-btn bg-slate-800 hover:bg-slate-700 text-xs font-medium px-3 py-2 rounded-lg transition">Son 30 Gün</button>
        <button onclick="setQuickRange('all', this)" class="range-btn bg-sky-600 text-white text-xs font-bold px-3 py-2 rounded-lg transition">Tümü</button>
      </div>

      <!-- Özel Tarih, Coin ve Yön Seçiciler -->
      <div class="flex flex-wrap gap-3 items-center">
        <div class="flex items-center gap-2 bg-slate-950 border border-slate-800 px-3 py-1.5 rounded-xl">
          <span class="text-xs text-slate-500">Başlangıç:</span>
          <input type="date" id="startDate" onchange="clearQuickBtn(); applyFilters()" class="bg-transparent text-xs text-slate-200 focus:outline-none" />
        </div>
        <div class="flex items-center gap-2 bg-slate-950 border border-slate-800 px-3 py-1.5 rounded-xl">
          <span class="text-xs text-slate-500">Bitiş:</span>
          <input type="date" id="endDate" onchange="clearQuickBtn(); applyFilters()" class="bg-transparent text-xs text-slate-200 focus:outline-none" />
        </div>
        <select id="coinFilter" onchange="applyFilters()" class="bg-slate-950 border border-slate-800 text-xs text-slate-200 px-3 py-2 rounded-xl focus:outline-none">
          <option value="ALL">Tüm Pariteler (Coinler)</option>
        </select>
        <select id="resultFilter" onchange="applyFilters()" class="bg-slate-950 border border-slate-800 text-xs text-slate-200 px-3 py-2 rounded-xl focus:outline-none">
          <option value="ALL">Tüm Sonuçlar</option>
          <option value="WIN">Sadece Kârlı İşlemler</option>
          <option value="LOSS">Sadece Zararlı İşlemler</option>
        </select>
      </div>
    </div>

    <div id="loading" class="text-center py-16 text-slate-400">Borsa verileri analiz ediliyor...</div>

    <div id="dashboard" class="hidden space-y-6">
      
      <!-- 6'lı Gelişmiş KPI Kartları -->
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <div class="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl">
          <div class="text-slate-400 text-[11px] font-semibold uppercase">Net Kâr / Zarar</div>
          <div id="totalPnl" class="text-xl font-extrabold mt-1">0.00 $</div>
        </div>
        <div class="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl">
          <div class="text-slate-400 text-[11px] font-semibold uppercase">Başarı Oranı</div>
          <div id="winRate" class="text-xl font-extrabold mt-1 text-sky-400">%0.0</div>
        </div>
        <div class="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl">
          <div class="text-slate-400 text-[11px] font-semibold uppercase">Profit Factor</div>
          <div id="profitFactor" class="text-xl font-extrabold mt-1 text-purple-400">0.00</div>
        </div>
        <div class="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl">
          <div class="text-slate-400 text-[11px] font-semibold uppercase">İşlem Sayısı (K/Z)</div>
          <div id="winLoss" class="text-xl font-extrabold mt-1">0 <span class="text-xs font-normal text-slate-400">(0/0)</span></div>
        </div>
        <div class="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl">
          <div class="text-slate-400 text-[11px] font-semibold uppercase">Ort. Kazanç / Kayıp</div>
          <div id="avgWinLoss" class="text-sm font-bold mt-2"><span class="text-emerald-400">+0.00</span> / <span class="text-rose-400">-0.00</span></div>
        </div>
        <div class="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl">
          <div class="text-slate-400 text-[11px] font-semibold uppercase">En İyi / En Kötü İşlem</div>
          <div id="bestWorstTrade" class="text-sm font-bold mt-2"><span class="text-emerald-400">+0.00</span> / <span class="text-rose-400">-0.00</span></div>
        </div>
      </div>

      <!-- Kümülatif Kâr/Zarar Grafiği + Açık Pozisyonlar -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Bakiye Eğrisi -->
        <div class="lg:col-span-2 bg-slate-900/90 border border-slate-800 p-5 rounded-2xl">
          <div class="flex justify-between items-center mb-4">
            <h2 class="font-bold text-slate-200 text-sm uppercase tracking-wider">Kümülatif PnL Eğrisi (USDT)</h2>
            <span id="chartSubtitle" class="text-xs text-slate-500">Seçili filtreye göre</span>
          </div>
          <div class="h-64 w-full">
            <canvas id="pnlChart"></canvas>
          </div>
        </div>

        <!-- En İyi & En Kötü Pariteler -->
        <div class="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden flex flex-col">
          <div class="p-4 border-b border-slate-800 font-bold text-sm uppercase tracking-wider text-emerald-400">Parite Sıralaması</div>
          <div class="overflow-y-auto max-h-72 flex-1">
            <table class="w-full text-xs text-left">
              <thead class="bg-slate-950/60 text-slate-400 uppercase">
                <tr>
                  <th class="p-3">Coin</th>
                  <th class="p-3">Adet</th>
                  <th class="p-3">Başarı</th>
                  <th class="p-3 text-right">Net PnL</th>
                </tr>
              </thead>
              <tbody id="bestPairsBody" class="divide-y divide-slate-800/60"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Açık Pozisyonlar Tablosu -->
      <div class="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden">
        <div class="p-4 border-b border-slate-800 flex justify-between items-center">
          <span class="font-bold text-sm uppercase tracking-wider" style="color: ${themeHex}">Anlık Açık Pozisyonlar</span>
          <span id="openCountBadge" class="text-xs bg-slate-800 px-2.5 py-1 rounded-full text-slate-300">0 Aktif</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm text-left">
            <thead class="bg-slate-950/60 text-slate-400 text-xs uppercase">
              <tr>
                <th class="p-4">Parite</th>
                <th class="p-4">Yön</th>
                <th class="p-4">Büyüklük</th>
                <th class="p-4">Giriş Fiyatı</th>
                <th class="p-4">Mark Fiyat</th>
                <th class="p-4 text-right">Anlık PnL</th>
              </tr>
            </thead>
            <tbody id="openPositionsBody" class="divide-y divide-slate-800/60"></tbody>
          </table>
        </div>
      </div>

      <!-- Kapanan İşlemler Geçmişi -->
      <div class="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden">
        <div class="p-4 border-b border-slate-800 flex justify-between items-center">
          <span class="font-bold text-sm uppercase tracking-wider text-slate-200">Filtrelenmiş İşlem Geçmişi</span>
          <span id="filteredCountBadge" class="text-xs text-slate-400">0 İşlem</span>
        </div>
        <div class="overflow-x-auto max-h-96">
