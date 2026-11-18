export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Sadece POST istekleri kabul edilir.");
  }

  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    let rawText = Buffer.concat(chunks).toString("utf8").trim();
    if (rawText.startsWith('"') && rawText.endsWith('"')) {
      rawText = rawText.slice(1, -1);
    }

    const parts = rawText.split("|").map((p) => p.trim());
    const startIndex = ["BUY", "SELL", "TP", "SL"].includes(parts.at(0)) ? 0 : 1;

    const action = parts.at(startIndex);
    const symbol = (parts.at(startIndex + 1) || "").replace(".P", "").toUpperCase();
    const signalPrice = parseFloat(parts.at(startIndex + 2));

    if (!["BUY", "SELL", "TP", "SL"].includes(action)) {
      return res.status(400).send("Geçersiz işlem yönü: " + action);
    }

    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;
    const crypto = await import("node:crypto");
    const https = await import("node:https");
    const demoHost = "testnet.binancefuture." + "com";

    function httpsRequest(hostname, path, method, headers = {}) {
      return new Promise((resolve, reject) => {
        const options = {
          hostname,
          port: 443,
          path,
          method,
          family: 4,
          headers: { "User-Agent": "BinanceTradingBot/1.0", ...headers },
        };
        const request = https.request(options, (response) => {
          let data = "";
          response.on("data", (chunk) => (data += chunk));
          response.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (_e) {
              reject(new Error(`${path} hatası (HTTP ${response.statusCode}): ${data.slice(0, 120)}`));
            }
          });
        });
        request.on("error", reject);
        request.end();
      });
    }

    async function sendBinanceRequest(method, endpoint, paramsObj = {}) {
      const timestamp = Date.now();
      const queryParams = new URLSearchParams({
        ...paramsObj,
        recvWindow: "5000",
        timestamp: String(timestamp),
      }).toString();

      const signature = crypto.createHmac("sha256", apiSecret).update(queryParams).digest("hex");
      const fullPath = `${endpoint}?${queryParams}&signature=${signature}`;
      return await httpsRequest(demoHost, fullPath, method, { "X-MBX-APIKEY": apiKey });
    }

    // Mevcut Açık Pozisyonu Kontrol Et
    const posList = await sendBinanceRequest("GET", "/fapi/v2/positionRisk", { symbol });
    const activePos = Array.isArray(posList) ? posList.find((p) => parseFloat(p.positionAmt) !== 0) : null;

    // 1. DURUM: TP veya SL Sinyali Geldiyse Açık Pozisyonu Kapat
    if (action === "TP" || action === "SL") {
      if (!activePos) {
        return res.status(200).json({ status: "Ignored", reason: `${symbol} için kapatılacak açık pozisyon yok.` });
      }

      const currentAmt = parseFloat(activePos.positionAmt);
      const closeSide = currentAmt > 0 ? "SELL" : "BUY";

      const closeRes = await sendBinanceRequest("POST", "/fapi/v1/order", {
        symbol,
        side: closeSide,
        type: "MARKET",
        quantity: String(Math.abs(currentAmt)),
        reduceOnly: "true",
      });

      return res.status(200).json({
        status: "ClosedBySignal",
        trigger: action,
        symbol,
        binanceResponse: closeRes,
      });
    }

    // 2. DURUM: BUY veya SELL Sinyali Geldiyse
    const targetSide = action === "BUY" ? "BUY" : "SELL";
    const closeSide = action === "BUY" ? "SELL" : "BUY";

    if (activePos) {
      const currentAmt = parseFloat(activePos.positionAmt);
      const currentSide = currentAmt > 0 ? "BUY" : "SELL";

      if (currentSide === targetSide) {
        return res.status(200).json({ status: "Ignored", reason: `Zaten açık bir ${currentSide} pozisyonu mevcut.` });
      }

      // Ters sinyal geldiyse önce kapat
      const closeRes = await sendBinanceRequest("POST", "/fapi/v1/order", {
        symbol,
        side: closeSide,
        type: "MARKET",
        quantity: String(Math.abs(currentAmt)),
        reduceOnly: "true",
      });

      if (closeRes.code && closeRes.code !== 200) {
        return res.status(200).json({ status: "CloseError", binanceResponse: closeRes });
      }
    }

    // Parite Miktar Kurallarını Çek
    const exchangeInfo = await httpsRequest(demoHost, "/fapi/v1/exchangeInfo", "GET");
    const symbolInfo = (exchangeInfo?.symbols || []).find((s) => s.symbol === symbol);
    if (!symbolInfo) {
      return res.status(400).json({ status: "SymbolError", reason: `${symbol} paritesi bulunamadı.` });
    }

    const lotFilter = symbolInfo.filters.find((f) => f.filterType === "LOT_SIZE");
    const stepSizeStr = lotFilter?.stepSize || "0.001";
    const minQty = parseFloat(lotFilter?.minQty || "0.001");
    const stepSize = parseFloat(stepSizeStr);
    const qtyDecimals = stepSizeStr.includes(".") ? stepSizeStr.split(".").at(1).replace(/0+$/, "").length : 0;

    // Kaldıracı 10x Ayarla
    let targetLeverage = 10;
    const levRes = await sendBinanceRequest("POST", "/fapi/v1/leverage", {
      symbol,
      leverage: String(targetLeverage),
    });
    if (levRes?.leverage) {
      targetLeverage = parseInt(levRes.leverage, 10);
    }

    // 10 Dolar Teminat x Kaldıraç Hesabı
    const positionValueUsdt = 10 * targetLeverage;
    let rawQty = positionValueUsdt / signalPrice;
    let finalQty = Math.floor(rawQty / stepSize) * stepSize;
    if (finalQty < minQty) finalQty = minQty;
    const formattedQty = finalQty.toFixed(qtyDecimals);

    // Sadece Piyasa Emrini Aç (Open Orders boş kalır, TP/SL sinyali beklenir)
    const mainOrder = await sendBinanceRequest("POST", "/fapi/v1/order", {
      symbol,
      side: targetSide,
      type: "MARKET",
      quantity: formattedQty,
    });

    return res.status(200).json({
      status: "Completed",
      symbol,
      side: targetSide,
      appliedLeverage: targetLeverage,
      calculatedQty: formattedQty,
      note: "Open Orders eklenmedi, TP/SL sinyali bekleniyor.",
      mainOrder,
    });
  } catch (err) {
    return res.status(500).json({ status: "CodeError", message: err.message });
  }
}