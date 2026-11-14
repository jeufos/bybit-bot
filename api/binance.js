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

    // Şifre varsa atla, yoksa doğrudan BUY/SELL oku
    const startIndex = (parts.at(0) === "BUY" || parts.at(0) === "SELL" || parts.at(0) === "TP" || parts.at(0) === "SL") ? 0 : 1;

    const action = parts.at(startIndex);
    const symbol = (parts.at(startIndex + 1) || "").replace(".P", "").toUpperCase();
    const signalPrice = parseFloat(parts.at(startIndex + 2));

    if (action === "TP" || action === "SL") {
      return res.status(200).json({ status: "Ignored", reason: "TP/SL zaten emre tanımlandı." });
    }

    if (action !== "BUY" && action !== "SELL") {
      return res.status(400).send("Geçersiz işlem yönü: " + action);
    }

    const targetSide = action === "BUY" ? "BUY" : "SELL";
    const closeSide = action === "BUY" ? "SELL" : "BUY";

    // TP ve SL Fiyatlarını Ayıkla
    let rawTp = "";
    let rawSl = "";

    for (const item of parts.slice(startIndex + 3)) {
      if (item.startsWith("TP:")) {
        const val = item.replace("TP:", "").trim();
        if (val !== "NaN" && val !== "" && parseFloat(val) > 0) rawTp = val;
      }
      if (item.startsWith("SL:")) {
        const val = item.replace("SL:", "").trim();
        if (val !== "NaN" && val !== "" && parseFloat(val) > 0) rawSl = val;
      }
    }

    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;
    const crypto = await import("node:crypto");
    const https = await import("node:https");

    const demoHost = "testnet.binancefuture." + "com";

    function httpsRequest(hostname, path, method, headers = {}, body = null) {
      return new Promise((resolve, reject) => {
        const options = {
          hostname: hostname,
          port: 443,
          path: path,
          method: method,
          family: 4,
          headers: {
            "User-Agent": "BinanceTradingBot/1.0",
            ...headers
          }
        };

        const request = https.request(options, (response) => {
          let data = "";
          response.on("data", (chunk) => (data += chunk));
          response.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (_e) {
              reject(new Error(`${path} adımında geçersiz yanıt (HTTP ${response.statusCode}): ${data.slice(0, 120)}`));
            }
          });
        });

        request.on("error", (err) => reject(err));
        if (body) request.write(body);
        request.end();
      });
    }

    async function sendBinanceRequest(method, endpoint, paramsObj = {}) {
      const timestamp = Date.now();
      const queryParams = new URLSearchParams({
        ...paramsObj,
        recvWindow: "5000",
        timestamp: String(timestamp)
      }).toString();

      const signature = crypto
        .createHmac("sha256", apiSecret)
        .update(queryParams)
        .digest("hex");

      const fullPath = `${endpoint}?${queryParams}&signature=${signature}`;
      const headers = {
        "X-MBX-APIKEY": apiKey
      };

      return await httpsRequest(demoHost, fullPath, method, headers);
    }

    // 1. Parite Kurallarını (stepSize ve tickSize) Çek
    const exchangeInfo = await httpsRequest(demoHost, "/fapi/v1/exchangeInfo", "GET");
    const symbolInfo = (exchangeInfo?.symbols || []).find((s) => s.symbol === symbol);

    if (!symbolInfo) {
      return res.status(400).json({
        status: "SymbolError",
        reason: `${symbol} paritesi Binance Futures Demo üzerinde bulunamadı.`
      });
    }

    const lotFilter = symbolInfo.filters.find((f) => f.filterType === "LOT_SIZE");
    const priceFilter = symbolInfo.filters.find((f) => f.filterType === "PRICE_FILTER");

    const stepSizeStr = lotFilter?.stepSize || "0.001";
    const minQty = parseFloat(lotFilter?.minQty || "0.001");
    const stepSize = parseFloat(stepSizeStr);
    const qtyDecimals = stepSizeStr.includes(".") ? stepSizeStr.split(".").at(1).replace(/0+$/, "").length : 0;

    const tickSizeStr = priceFilter?.tickSize || "0.01";
    const tickSize = parseFloat(tickSizeStr);
    const priceDecimals = tickSizeStr.includes(".") ? tickSizeStr.split(".").at(1).replace(/0+$/, "").length : 0;

    function formatPrice(priceStr) {
      if (!priceStr) return "";
      const num = parseFloat(priceStr);
      if (isNaN(num) || num <= 0) return "";
      const rounded = Math.round(num / tickSize) * tickSize;
      return rounded.toFixed(priceDecimals);
    }

    const takeProfit = formatPrice(rawTp);
    const stopLoss = formatPrice(rawSl);

    // 2. Mevcut Açık Pozisyonu Kontrol Et
    const posList = await sendBinanceRequest("GET", "/fapi/v2/positionRisk", { symbol: symbol });
    const activePos = Array.isArray(posList) ? posList.find((p) => parseFloat(p.positionAmt) !== 0) : null;

    if (activePos) {
      const currentAmt = parseFloat(activePos.positionAmt);
      const currentSide = currentAmt > 0 ? "BUY" : "SELL";

      // Aynı yönde pozisyon açıksa yeni işlem açma
      if (currentSide === targetSide) {
        return res.status(200).json({
          status: "Ignored",
          reason: `Zaten açık bir ${currentSide} pozisyonu mevcut.`
        });
      }

      // Ters yönde sinyal geldiyse önce açık emirleri (eski TP/SL) iptal et ve pozisyonu kapat
      await sendBinanceRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol: symbol });
      const closeRes = await sendBinanceRequest("POST", "/fapi/v1/order", {
        symbol: symbol,
        side: closeSide,
        type: "MARKET",
        quantity: String(Math.abs(currentAmt)),
        reduceOnly: "true"
      });

      if (closeRes.code && closeRes.code !== 200) {
        return res.status(200).json({
          status: "CloseError",
          binanceResponse: closeRes
        });
      }
    }

    // 3. Kaldıracı 10x Yap (İzin verilen maksimum kaldıraç düşükse otomatik düşürür)
    let targetLeverage = 10;
    const levRes = await sendBinanceRequest("POST", "/fapi/v1/leverage", {
      symbol: symbol,
      leverage: String(targetLeverage)
    });
    if (levRes?.leverage) {
      targetLeverage = parseInt(levRes.leverage, 10);
    }

    // 4. 10 Dolar Teminat x Kaldıraç ile Miktar Hesapla
    const marginUsdt = 10;
    const positionValueUsdt = marginUsdt * targetLeverage;
    let rawQty = positionValueUsdt / signalPrice;
    let finalQty = Math.floor(rawQty / stepSize) * stepSize;
    if (finalQty < minQty) finalQty = minQty;
    const formattedQty = finalQty.toFixed(qtyDecimals);

    // 5. Ana Piyasa Emrini Aç
    const mainOrder = await sendBinanceRequest("POST", "/fapi/v1/order", {
      symbol: symbol,
      side: targetSide,
      type: "MARKET",
      quantity: formattedQty
    });

    if (mainOrder.code && mainOrder.code !== 200) {
      return res.status(200).json({
        status: "OrderError",
        binanceResponse: mainOrder
      });
    }

    // 6. Varsa TP ve SL Emirlerini Pozisyona Bağla
    let tpOrder = null;
    let slOrder = null;

    if (takeProfit) {
      tpOrder = await sendBinanceRequest("POST", "/fapi/v1/order", {
        symbol: symbol,
        side: closeSide,
        type: "TAKE_PROFIT_MARKET",
        stopPrice: takeProfit,
        closePosition: "true",
        workingType: "MARK_PRICE"
      });
    }

    if (stopLoss) {
      slOrder = await sendBinanceRequest("POST", "/fapi/v1/order", {
        symbol: symbol,
        side: closeSide,
        type: "STOP_MARKET",
        stopPrice: stopLoss,
        closePosition: "true",
        workingType: "MARK_PRICE"
      });
    }

    return res.status(200).json({
      status: "Completed",
      symbol: symbol,
      appliedLeverage: targetLeverage,
      calculatedQty: formattedQty,
      tp: takeProfit,
      sl: stopLoss,
      mainOrder: mainOrder,
      tpOrder: tpOrder,
      slOrder: slOrder
    });

  } catch (err) {
    return res.status(500).json({
      status: "CodeError",
      message: err.message
    });
  }
}
