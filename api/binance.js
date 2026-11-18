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

    const startIndex =
      parts.at(0) === "BUY" ||
      parts.at(0) === "SELL" ||
      parts.at(0) === "TP" ||
      parts.at(0) === "SL"
        ? 0
        : 1;

    const action = parts.at(startIndex);
    const symbol = (parts.at(startIndex + 1) || "")
      .replace(".P", "")
      .toUpperCase();
    const signalPrice = parseFloat(parts.at(startIndex + 2));

    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;
    const crypto = await import("node:crypto");
    const https = await import("node:https");

    const demoHost = "testnet.binancefuture." + "com";
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function httpsRequest(hostname, path, method, headers = {}, body = null) {
      return new Promise((resolve, reject) => {
        const options = {
          hostname,
          port: 443,
          path,
          method,
          family: 4,
          headers: {
            "User-Agent": "BinanceTradingBot/1.0",
            ...headers,
          },
        };

        const request = https.request(options, (response) => {
          let data = "";
          response.on("data", (chunk) => (data += chunk));
          response.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (_e) {
              reject(
                new Error(
                  `${path} adımında geçersiz yanıt (HTTP ${response.statusCode}): ${data.slice(0, 120)}`
                )
              );
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
        timestamp: String(timestamp),
      }).toString();

      const signature = crypto
        .createHmac("sha256", apiSecret)
        .update(queryParams)
        .digest("hex");

      const fullPath = `${endpoint}?${queryParams}&signature=${signature}`;
      const headers = {
        "X-MBX-APIKEY": apiKey,
      };

      return await httpsRequest(demoHost, fullPath, method, headers);
    }

    // 1. Parite kuralları
    const exchangeInfo = await httpsRequest(
      demoHost,
      "/fapi/v1/exchangeInfo",
      "GET"
    );
    const symbolInfo = (exchangeInfo?.symbols || []).find(
      (s) => s.symbol === symbol
    );

    if (!symbolInfo) {
      return res.status(400).json({
        status: "SymbolError",
        reason: `${symbol} paritesi Binance Futures Demo üzerinde bulunamadı.`,
      });
    }

    const lotFilter = symbolInfo.filters.find(
      (f) => f.filterType === "LOT_SIZE"
    );
    const priceFilter = symbolInfo.filters.find(
      (f) => f.filterType === "PRICE_FILTER"
    );

    const stepSizeStr = lotFilter?.stepSize || "0.001";
    const minQty = parseFloat(lotFilter?.minQty || "0.001");
    const stepSize = parseFloat(stepSizeStr);
    const qtyDecimals = stepSizeStr.includes(".")
      ? stepSizeStr.split(".").at(1).replace(/0+$/, "").length
      : 0;

    const tickSizeStr = priceFilter?.tickSize || "0.01";
    const tickSize = parseFloat(tickSizeStr);
    const priceDecimals = tickSizeStr.includes(".")
      ? tickSizeStr.split(".").at(1).replace(/0+$/, "").length
      : 0;

    function formatPrice(priceStr) {
      if (!priceStr) return "";
      const num = parseFloat(priceStr);
      if (isNaN(num) || num <= 0) return "";
      const rounded = Math.round(num / tickSize) * tickSize;
      return rounded.toFixed(priceDecimals);
    }

    // 2. Mevcut pozisyonu kontrol et
    const posList = await sendBinanceRequest("GET", "/fapi/v2/positionRisk", {
      symbol,
    });
    const activePos = Array.isArray(posList)
      ? posList.find((p) => parseFloat(p.positionAmt) !== 0)
      : null;

    // 3. TP / SL sinyali geldiğinde pozisyonu kapat
    if (action === "TP" || action === "SL") {
      if (!activePos) {
        return res.status(200).json({
          status: "Ignored",
          reason: "Kapatılacak açık pozisyon yok.",
        });
      }

      const currentAmt = parseFloat(activePos.positionAmt);
      const closeSide = currentAmt > 0 ? "SELL" : "BUY";

      // Varsa bekleyen emirleri temizle
      await sendBinanceRequest("DELETE", "/fapi/v1/allOpenOrders", {
        symbol,
      });

      const closeRes = await sendBinanceRequest("POST", "/fapi/v1/order", {
        symbol,
        side: closeSide,
        type: "MARKET",
        quantity: String(Math.abs(currentAmt)),
        reduceOnly: "true",
      });

      if (closeRes.code && closeRes.code !== 200) {
        return res.status(200).json({
          status: "CloseError",
          binanceResponse: closeRes,
        });
      }

      return res.status(200).json({
        status: "Closed",
        action,
        symbol,
        closedQty: Math.abs(currentAmt),
        closeSide,
        binanceResponse: closeRes,
      });
    }

    // 4. BUY / SELL kontrolü
    if (action !== "BUY" && action !== "SELL") {
      return res.status(400).send("Geçersiz işlem yönü: " + action);
    }

    const targetSide = action === "BUY" ? "BUY" : "SELL";
    const closeSide = action === "BUY" ? "SELL" : "BUY";

    // 5. Ters sinyal gelirse önce pozisyonu kapat
    if (activePos) {
      const currentAmt = parseFloat(activePos.positionAmt);
      const currentSide = currentAmt > 0 ? "BUY" : "SELL";

      if (currentSide === targetSide) {
        return res.status(200).json({
          status: "Ignored",
          reason: `Zaten açık bir ${currentSide} pozisyonu mevcut.`,
        });
      }

      await sendBinanceRequest("DELETE", "/fapi/v1/allOpenOrders", {
        symbol,
      });

      const closeRes = await sendBinanceRequest("POST", "/fapi/v1/order", {
        symbol,
        side: closeSide,
        type: "MARKET",
        quantity: String(Math.abs(currentAmt)),
        reduceOnly: "true",
      });

      if (closeRes.code && closeRes.code !== 200) {
        return res.status(200).json({
          status: "CloseError",
          binanceResponse: closeRes,
        });
      }

      await sleep(300);
    }

    // 6. Kaldıraç 10x
    let targetLeverage = 10;
    const levRes = await sendBinanceRequest("POST", "/fapi/v1/leverage", {
      symbol,
      leverage: String(targetLeverage),
    });
    if (levRes?.leverage) {
      targetLeverage = parseInt(levRes.leverage, 10);
    }

    // 7. 10 $ teminat x 10x ile miktar
    const marginUsdt = 10;
    const positionValueUsdt = marginUsdt * targetLeverage;
    const rawQty = positionValueUsdt / signalPrice;
    let finalQty = Math.floor(rawQty / stepSize) * stepSize;
    if (finalQty < minQty) finalQty = minQty;
    const formattedQty = finalQty.toFixed(qtyDecimals);

    // 8. Sadece giriş emri aç; TP/SL bağlanmaz
    const mainOrder = await sendBinanceRequest("POST", "/fapi/v1/order", {
      symbol,
      side: targetSide,
      type: "MARKET",
      quantity: formattedQty,
    });

    if (mainOrder.code && mainOrder.code !== 200) {
      return res.status(200).json({
        status: "OrderError",
        binanceResponse: mainOrder,
      });
    }

    return res.status(200).json({
      status: "Opened",
      action,
      symbol,
      side: targetSide,
      appliedLeverage: targetLeverage,
      calculatedQty: formattedQty,
      mainOrder,
    });
  } catch (err) {
    return res.status(500).json({
      status: "CodeError",
      message: err.message,
    });
  }
}
