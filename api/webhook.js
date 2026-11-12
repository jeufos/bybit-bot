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
    const rawText = Buffer.concat(chunks).toString("utf8").trim();
    const parts = rawText.split("|");

    // 1. Güvenlik Şifresi Kontrolü
    if (parts.at(0) !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({
        status: "AuthError",
        gelenSifre: parts.at(0),
        beklenenSifreTanimliMi: Boolean(process.env.WEBHOOK_SECRET)
      });
    }

    const action = parts.at(1);
    const symbol = parts.at(2).replace(".P", "");
    const signalPrice = parseFloat(parts.at(3));

    if (action === "TP" || action === "SL") {
      return res.status(200).json({ status: "Ignored", reason: "TP/SL zaten emre tanımlandı." });
    }

    if (action !== "BUY" && action !== "SELL") {
      return res.status(400).send("Geçersiz işlem yönü: " + action);
    }

    const targetSide = action === "BUY" ? "Buy" : "Sell";

    // 2. TP ve SL Fiyatlarını Ayıkla
    let takeProfit = "";
    let stopLoss = "";

    for (const item of parts.slice(4)) {
      if (item.startsWith("TP:")) {
        const val = item.replace("TP:", "");
        if (val !== "NaN" && val !== "" && parseFloat(val) > 0) takeProfit = val;
      }
      if (item.startsWith("SL:")) {
        const val = item.replace("SL:", "");
        if (val !== "NaN" && val !== "" && parseFloat(val) > 0) stopLoss = val;
      }
    }

    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    const crypto = await import("node:crypto");
    const https = await import("node:https");

    // IPv4 zorlamalı özel HTTPS istek fonksiyonu
    function httpsRequest(hostname, path, method, headers = {}, body = null) {
      return new Promise((resolve, reject) => {
        const options = {
          hostname: hostname,
          port: 443,
          path: path,
          method: method,
          family: 4, // IPv6 takılmalarını önlemek için IPv4 zorla
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

      return await httpsRequest("://bybit.com", fullPath, method, headers, method === "POST" ? bodyStr : null);
    }

    // 3. Mevcut Açık Pozisyonu Kontrol Et
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

    // 4. Parite Basamak Kurallarını Çek
    const infoData = await httpsRequest("://bybit.com", `/v5/market/instruments-info?category=linear&symbol=${symbol}`, "GET");
    const firstInstrument = infoData?.result?.list?.at(0);
    const qtyStepStr = firstInstrument?.lotSizeFilter?.qtyStep || "0.001";
    const minOrderQty = parseFloat(firstInstrument?.lotSizeFilter?.minOrderQty || "0.001");
    const qtyStep = parseFloat(qtyStepStr);
    const decimals = qtyStepStr.includes(".") ? qtyStepStr.split(".").at(1).length : 0;

    const marginUsdt = 10;
    const leverage = 10;
    const positionValueUsdt = marginUsdt * leverage;

    let rawQty = positionValueUsdt / signalPrice;
    let finalQty = Math.floor(rawQty / qtyStep) * qtyStep;
    if (finalQty < minOrderQty) finalQty = minOrderQty;
    const formattedQty = finalQty.toFixed(decimals);

    // 5. Kaldıracı 10x Yap
    await sendBybitRequest("POST", "/v5/position/set-leverage", {
      category: "linear",
      symbol: symbol,
      buyLeverage: String(leverage),
      sellLeverage: String(leverage)
    });

    // 6. Yeni Emri TP ve SL ile Aç
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
      calculatedQty: formattedQty,
      tp: takeProfit,
      sl: stopLoss,
      bybitResponse: orderResult
    });

  } catch (err) {
    return res.status(500).json({
      status: "CodeError",
      message: err.message,
      code: err.code || "UNKNOWN",
      cause: err.cause ? String(err.cause) : null
    });
  }
}
