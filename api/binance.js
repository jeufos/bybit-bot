import { neon } from "@neondatabase/serverless";

export const config = {
  api: {
    bodyParser: false,
  },
};

const sql = neon(process.env.DATABASE_URL);

const recentSignals = new Map();

function isDuplicate(action, symbol) {
  const key = `${action}_${symbol}`;
  const now = Date.now();
  const last = recentSignals.get(key);

  if (last && now - last < 30000) {
    return true;
  }

  recentSignals.set(key, now);
  return false;
}

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

    if (isNaN(signalPrice) || signalPrice <= 0) {
      return res.status(400).send(
        "Geçersiz fiyat: " + parts.at(startIndex + 2)
      );
    }

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

    // 1. Parite kurallarını çek
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

    // 2. Mevcut açık pozisyonu kontrol et
    const posList = await sendBinanceRequest("GET", "/fapi/v2/positionRisk", {
      symbol,
    });
    const activePos = Array.isArray(posList)
      ? posList.find((p) => parseFloat(p.positionAmt) !== 0)
      : null;

    // 3. TP / SL sinyali geldiğinde pozisyonu kapat + DB’yi güncelle
    if (action === "TP" || action === "SL") {
      const openTrade = await sql`
        SELECT * FROM trades
        WHERE symbol = ${symbol}
          AND status = 'OPEN'
        ORDER BY id DESC
        LIMIT 1
      `;

      if (openTrade.length === 0) {
        return res.status(200).json({
          status: "Ignored",
          reason: "Kapatılacak açık pozisyon yok.",
        });
      }

      const trade = openTrade[0];
      const entryPrice = parseFloat(trade.entry_price);
      const side = trade.side;

      const notional = 10 * 10;
      const qty = notional / entryPrice;

      let grossPnl;
      if (side === "LONG") {
        grossPnl = (signalPrice - entryPrice) * qty;
      } else {
        grossPnl = (entryPrice - signalPrice) * qty;
      }

      const fees = notional * 0.0005 * 2;
      const netPnl = grossPnl - fees;
      const netPct = (netPnl / 10) * 100;

      await sql`
        UPDATE trades
        SET
          exit_price = ${signalPrice},
          gross_pnl = ${grossPnl},
          fees = ${fees},
          net_pnl = ${netPnl},
          net_pct = ${netPct},
          status = 'CLOSED'
        WHERE id = ${trade.id}
      `;

      if (!activePos) {
        return res.status(200).json({
          status: "Ignored",
          reason: "Kapatılacak açık pozisyon yok.",
        });
      }

      const currentAmt = parseFloat(activePos.positionAmt);
      const closeSide = currentAmt > 0 ? "SELL" : "BUY";

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

    if (isDuplicate(action, symbol)) {
      return res.status(200).json({
        status: "Ignored",
        reason: "Aynı sinyal kısa süre içinde tekrar geldi.",
      });
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

    // 7. 10 $ teminat x 10x ile miktar hesapla
    const marginUsdt = 10;
    const positionValueUsdt = marginUsdt * targetLeverage;
    const rawQty = positionValueUsdt / signalPrice;
    let finalQty = Math.floor(rawQty / stepSize) * stepSize;
    if (finalQty < minQty) finalQty = minQty;
    const formattedQty = finalQty.toFixed(qtyDecimals);

    // 8. MIN_NOTIONAL kontrolü
    const notionalFilter = symbolInfo.filters.find(
      (f) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL"
    );

    const minNotional = parseFloat(
      notionalFilter?.minNotional || notionalFilter?.notional || "0"
    );

    if (minNotional > 0 && positionValueUsdt < minNotional) {
      return res.status(400).json({
        status: "NotionalError",
        reason: `Bu parite için minimum notional ${minNotional} USDT. Senin notional: ${positionValueUsdt} USDT.`,
      });
    }

    // 9. Sadece giriş emri aç; TP/SL bağlanmaz
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

    // 10. DB’ye OPEN kaydı ekle
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

    const side = action === "BUY" ? "LONG" : "SHORT";

    await sql`
      INSERT INTO trades
        (action, symbol, side, entry_price, tp_price, sl_price, status)
      VALUES
        (${action}, ${symbol}, ${side}, ${signalPrice}, ${rawTp}, ${rawSl}, 'OPEN')
    `;

    return res.status(200).json({
      status: "Opened",
      action,
      symbol,
      side,
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
