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

    // Eğer mesajın başında şifre varsa otomatik atla, yoksa doğrudan BUY/SELL'i oku
    const startIndex = (parts.at(0) === "BUY" || parts.at(0) === "SELL" || parts.at(0) === "TP" || parts.at(0) === "SL") ? 0 : 1;

    const action = parts.at(startIndex);
    const symbol = (parts.at(startIndex + 1) || "").replace(".P", "");
    const signalPrice = parseFloat(parts.at(startIndex + 2));

    if (action === "TP" || action === "SL") {
      return res.status(200).json({ status: "Ignored", reason: "TP/SL zaten emre tanımlandı." });
    }

    if (action !== "BUY" && action !== "SELL") {
      return res.status(400).send("Geçersiz işlem yönü: " + action);
    }

    const targetSide = action === "BUY" ? "Buy" : "Sell";

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

    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    const crypto = await import("node:crypto");
    const https = await import("node:https");

    const demoHost = "api-demo." + "bybit.com";
    const publicHost = "api." + "bybit.com";

    function httpsRequest(hostname, path, method, headers = {}, body = null) {
      return new Promise((resolve, reject) => {
        const options = {
          hostname: hostname,
          port: 443,
          path: path,
          method: method,
          family: 4,
          headers: {
            "User-Agent": "BybitTradingBot/1.0",
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
              reject(new Error(`${path} adımında geçersiz yanıt (HTTP ${response.statusCode}): ${data.slice(0, 100)}`));
            }
          });
        });

        request.on("error", (err) => reject(err));
        if (body) request.write(body);
        request.end();
      });
    }

    async function sendBybitRequest(method, endpoint, paramsObj = {}) {
      const timestamp = Date.now().toString();
      const recvWindow = "5000";
      let queryString = "";
      let bodyStr = "";
      let signPayload = "";

      if (method === "GET") {
        queryString = new URLSearchParams(paramsObj).toString();
        signPayload = timestamp + apiKey + recvWindow + queryString;
      } else {
        bodyStr = JSON.stringify(paramsObj);
        signPayload = timestamp + apiKey + recvWindow + bodyStr;
      }

      const signature = crypto
        .createHmac("sha256", apiSecret)
        .update(signPayload)
        .digest("hex");

      const fullPath = method === "GET" && queryString ? `${endpoint}?${queryString}` : endpoint;
      const headers = {
        "Content-Type": "application/json",
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-SIGN": signature,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow
      };

      if (method === "POST") {
        headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      return await httpsRequest(demoHost, fullPath, method, headers, method === "POST" ? bodyStr : null);
    }

    // Mevcut Açık Pozisyonu Kontrol Et
    const posRes = await sendBybitRequest("GET", "/v5/position/list", {
      category: "linear",
      symbol: symbol
    });

    const positions = posRes?.result?.list || [];
    const activePos = positions.find((p) => parseFloat(p.size) > 0);

    if (activePos) {
      if (activePos.side === targetSide) {
        return res.status(200).json({
          status: "Ignored",
          reason: `Zaten açık bir ${activePos.side} pozisyonu mevcut.`
        });
      }

      const closeSide = activePos.side === "Buy" ? "Sell" : "Buy";
      const closeRes = await sendBybitRequest("POST", "/v5/order/create", {
        category: "linear",
        symbol: symbol,
        side: closeSide,
        orderType: "Market",
        qty: activePos.size,
        reduceOnly: true
      });

      if (closeRes.retCode !== 0) {
        return res.status(200).json({
          status: "CloseError",
          bybitResponse: closeRes
        });
      }
    }

    // Parite Kurallarını Çek
    const infoData = await httpsRequest(publicHost, `/v5/market/instruments-info?category=linear&symbol=${symbol}`, "GET");
    const firstInstrument = infoData?.result?.list?.at(0);

    if (!firstInstrument) {
      return res.status(400).json({
        status: "SymbolError",
        reason: `${symbol} paritesi Bybit Linear API üzerinde bulunamadı.`
      });
    }

    const qtyStepStr = firstInstrument?.lotSizeFilter?.qtyStep || "0.001";
    const minOrderQty = parseFloat(firstInstrument?.lotSizeFilter?.minOrderQty || "0.001");
    const qtyStep = parseFloat(qtyStepStr);
    const qtyDecimals = qtyStepStr.includes(".") ? qtyStepStr.split(".").at(1).length : 0;

    const tickSizeStr = firstInstrument?.priceFilter?.tickSize || "0.01";
    const tickSize = parseFloat(tickSizeStr);
    const priceDecimals = tickSizeStr.includes(".") ? tickSizeStr.split(".").at(1).length : 0;

    function formatPrice(priceStr) {
      if (!priceStr) return "";
      const num = parseFloat(priceStr);
      if (isNaN(num) || num <= 0) return "";
      const rounded = Math.round(num / tickSize) * tickSize;
      return rounded.toFixed(priceDecimals);
    }

    const takeProfit = formatPrice(rawTp);
    const stopLoss = formatPrice(rawSl);

    const maxAllowedLeverage = parseFloat(firstInstrument?.leverageFilter?.maxLeverage || "10");
    const targetLeverage = Math.min(10, maxAllowedLeverage);

    const marginUsdt = 10;
    const positionValueUsdt = marginUsdt * targetLeverage;

    let rawQty = positionValueUsdt / signalPrice;
    let finalQty = Math.floor(rawQty / qtyStep) * qtyStep;
    if (finalQty < minOrderQty) finalQty = minOrderQty;
    const formattedQty = finalQty.toFixed(qtyDecimals);

    // Kaldıracı Ayarla
    await sendBybitRequest("POST", "/v5/position/set-leverage", {
      category: "linear",
      symbol: symbol,
      buyLeverage: String(targetLeverage),
      sellLeverage: String(targetLeverage)
    });

    // Yeni Emri Aç
    const orderData = {
      category: "linear",
      symbol: symbol,
      side: targetSide,
      orderType: "Market",
      qty: formattedQty,
      tpslMode: "Full",
      tpOrderType: "Market",
      slOrderType: "Market"
    };

    if (takeProfit) orderData.takeProfit = takeProfit;
    if (stopLoss) orderData.stopLoss = stopLoss;

    const orderResult = await sendBybitRequest("POST", "/v5/order/create", orderData);

    return res.status(200).json({
      status: "Completed",
      symbol: symbol,
      appliedLeverage: targetLeverage,
      calculatedQty: formattedQty,
      tp: takeProfit,
      sl: stopLoss,
      bybitResponse: orderResult
    });

  } catch (err) {
    return res.status(500).json({
      status: "CodeError",
      message: err.message
    });
  }
}
