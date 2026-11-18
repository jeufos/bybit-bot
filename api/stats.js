export default async function handler(req, res) {
  const exchange = (req.query.exchange || "bybit").toLowerCase();
  const crypto = await import("node:crypto");
  const https = await import("node:https");

  function httpsRequest(hostname, path, method, headers = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname,
        port: 443,
        path,
        method,
        family: 4,
        headers: { "User-Agent": "TradingDashboard/1.0", ...headers },
      };
      const request = https.request(options, (response) => {
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (_e) {
            reject(new Error(`Geçersiz yanıt (HTTP ${response.statusCode}): ${data.slice(0, 100)}`));
          }
        });
      });
      request.on("error", reject);
      request.end();
    });
  }

  try {
    // ================= BYBIT ANALİZİ =================
    if (exchange === "bybit") {
      const apiKey = process.env.BYBIT_API_KEY;
      const apiSecret = process.env.BYBIT_API_SECRET;
      const host = "api-demo." + "bybit.com";

      async function bybitGet(endpoint, paramsObj) {
        const timestamp = Date.now().toString();
        const recvWindow = "5000";
        const query = new URLSearchParams(paramsObj).toString();
        const signPayload = timestamp + apiKey + recvWindow + query;
        const signature = crypto.createHmac("sha256", apiSecret).update(signPayload).digest("hex");

        return await httpsRequest(host, `${endpoint}?${query}`, "GET", {
          "X-BAPI-API-KEY": apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        });
      }

      const [pnlRes, posRes] = await Promise.all([
        bybitGet("/v5/position/closed-pnl", { category: "linear", limit: "100" }),
        bybitGet("/v5/position/list", { category: "linear", settleCoin: "USDT" }),
      ]);

      const closedList = pnlRes?.result?.list || [];
      const openList = (posRes?.result?.list || []).filter((p) => parseFloat(p.size) > 0);

      let totalPnl = 0;
      let wins = 0;
      let losses = 0;
      const pairMap = {};

      const trades = closedList.map((t) => {
        const pnl = parseFloat(t.closedPnl);
        totalPnl += pnl;
        if (pnl > 0) wins++;
        else if (pnl < 0) losses++;

        if (!pairMap[t.symbol]) pairMap[t.symbol] = { symbol: t.symbol, trades: 0, wins: 0, pnl: 0 };
        pairMap[t.symbol].trades++;
        pairMap[t.symbol].pnl += pnl;
        if (pnl > 0) pairMap[t.symbol].wins++;

        return {
          symbol: t.symbol,
          side: t.side === "Buy" ? "SHORT" : "LONG",
          qty: t.qty,
          entryPrice: t.avgEntryPrice,
          exitPrice: t.avgExitPrice,
          pnl: pnl,
          time: Number(t.updatedTime),
        };
      });

      const totalTrades = wins + losses;
      const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0.0";
      const bestPairs = Object.values(pairMap)
        .map((p) => ({
          ...p,
          winRate: p.trades > 0 ? ((p.wins / p.trades) * 100).toFixed(1) : "0.0",
        }))
        .sort((a, b) => b.pnl - a.pnl);

      const openPositions = openList.map((p) => ({
        symbol: p.symbol,
        side: p.side === "Buy" ? "LONG" : "SHORT",
        size: p.size,
        entryPrice: p.avgPrice,
        markPrice: p.markPrice,
        unrealizedPnl: parseFloat(p.unrealisedPnl),
        leverage: p.leverage,
      }));

      return res.status(200).json({
        exchange: "Bybit Demo",
        summary: { totalTrades, wins, losses, winRate, totalPnl },
        bestPairs,
        openPositions,
        recentTrades: trades,
      });
    }

    // ================= BINANCE ANALİZİ (HIZLANDIRILMIŞ) =================
    if (exchange === "binance") {
      const apiKey = process.env.BINANCE_API_KEY;
      const apiSecret = process.env.BINANCE_API_SECRET;
      const host = "testnet.binancefuture." + "com";

      async function binanceGet(endpoint, paramsObj = {}) {
        const query = new URLSearchParams({
          ...paramsObj,
          recvWindow: "5000",
          timestamp: String(Date.now()),
        }).toString();
        const signature = crypto.createHmac("sha256", apiSecret).update(query).digest("hex");
        return await httpsRequest(host, `${endpoint}?${query}&signature=${signature}`, "GET", {
          "X-MBX-APIKEY": apiKey,
        });
      }

      const [incomeRes, accountRes] = await Promise.all([
        binanceGet("/fapi/v1/income", { incomeType: "REALIZED_PNL", limit: "200" }),
        binanceGet("/fapi/v2/account", {}),
      ]);

      if (incomeRes && incomeRes.code) {
        return res.status(400).json({ error: `Binance API Hatası (${incomeRes.code}): ${incomeRes.msg}` });
      }

      const pnlRecords = Array.isArray(incomeRes) ? incomeRes.reverse() : [];
      const openList = Array.isArray(accountRes?.positions)
        ? accountRes.positions.filter((p) => parseFloat(p.positionAmt) !== 0)
        : [];

      let totalPnl = 0;
      let wins = 0;
      let losses = 0;
      const pairMap = {};

      const trades = pnlRecords.map((t) => {
        const pnl = parseFloat(t.income);
        totalPnl += pnl;
        if (pnl > 0) wins++;
        else if (pnl < 0) losses++;

        if (!pairMap[t.symbol]) pairMap[t.symbol] = { symbol: t.symbol, trades: 0, wins: 0, pnl: 0 };
        pairMap[t.symbol].trades++;
        pairMap[t.symbol].pnl += pnl;
        if (pnl > 0) pairMap[t.symbol].wins++;

        return {
          symbol: t.symbol,
          side: "KAPALI",
          qty: "-",
          entryPrice: "-",
          exitPrice: "-",
          pnl: pnl,
          time: Number(t.time),
        };
      });

      const totalTrades = wins + losses;
      const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0.0";
      const bestPairs = Object.values(pairMap)
        .map((p) => ({
          ...p,
          winRate: p.trades > 0 ? ((p.wins / p.trades) * 100).toFixed(1) : "0.0",
        }))
        .sort((a, b) => b.pnl - a.pnl);

      const openPositions = openList.map((p) => {
        const amt = parseFloat(p.positionAmt);
        return {
          symbol: p.symbol,
          side: amt > 0 ? "LONG" : "SHORT",
          size: String(Math.abs(amt)),
          entryPrice: p.entryPrice,
          markPrice: p.entryPrice,
          unrealizedPnl: parseFloat(p.unrealizedProfit),
          leverage: p.leverage,
        };
      });

      return res.status(200).json({
        exchange: "Binance Futures Demo",
        summary: { totalTrades, wins, losses, winRate, totalPnl },
        bestPairs,
        openPositions,
        recentTrades: trades,
      });
    }

    return res.status(400).json({ error: "Geçersiz borsa parametresi" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
