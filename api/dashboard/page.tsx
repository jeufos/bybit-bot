"use client";

import { useEffect, useState } from "react";

type Trade = {
  id: number;
  created_at: string;
  action: string;
  symbol: string;
  side: string;
  entry_price: string;
  exit_price: string | null;
  tp_price: string;
  sl_price: string;
  gross_pnl: string | null;
  fees: string | null;
  net_pnl: string | null;
  net_pct: string | null;
  status: string;
};

type SymbolStat = {
  symbol: string;
  trades: number;
  netPnl: number;
};

type DashboardData = {
  openPositions: Trade[];
  closedTrades: Trade[];
  stats: {
    totalClosed: number;
    winRate: string;
    totalNetPnl: string;
    bySymbol: SymbolStat[];
  };
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      try {
        const res = await fetch("/api/dashboard");
        const json = await res.json();
        setData(json);
      } catch (err: any) {
        setError(err.message);
      }
    }

    loadData();
  }, []);

  if (error) {
    return <div>Hata: {error}</div>;
  }

  if (!data) {
    return <div>Yükleniyor...</div>;
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Trading Dashboard</h1>

      <h2>Özet</h2>
      <p>Toplam kapanan işlem: {data.stats.totalClosed}</p>
      <p>Win rate: {data.stats.winRate}</p>
      <p>Toplam net PnL: {data.stats.totalNetPnl} USDT</p>

      <h2>Açık Pozisyonlar</h2>
      <table border={1} cellPadding={8}>
        <thead>
          <tr>
            <th>Coin</th>
            <th>Yön</th>
            <th>Giriş</th>
            <th>TP</th>
            <th>SL</th>
          </tr>
        </thead>
        <tbody>
          {data.openPositions.map((t) => (
            <tr key={t.id}>
              <td>{t.symbol}</td>
              <td>{t.side}</td>
              <td>{t.entry_price}</td>
              <td>{t.tp_price}</td>
              <td>{t.sl_price}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Coin Bazında Performans</h2>
      <table border={1} cellPadding={8}>
        <thead>
          <tr>
            <th>Coin</th>
            <th>İşlem</th>
            <th>Net PnL</th>
          </tr>
        </thead>
        <tbody>
          {data.stats.bySymbol.map((s) => (
            <tr key={s.symbol}>
              <td>{s.symbol}</td>
              <td>{s.trades}</td>
              <td>{s.netPnl.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Son İşlemler</h2>
      <table border={1} cellPadding={8}>
        <thead>
          <tr>
            <th>Zaman</th>
            <th>Tip</th>
            <th>Coin</th>
            <th>Yön</th>
            <th>Giriş</th>
            <th>Çıkış</th>
            <th>Net PnL</th>
            <th>Net %</th>
            <th>Durum</th>
          </tr>
        </thead>
        <tbody>
          {data.closedTrades
            .slice()
            .reverse()
            .slice(0, 10)
            .map((t) => (
              <tr key={t.id}>
                <td>{new Date(t.created_at).toLocaleString()}</td>
                <td>{t.action}</td>
                <td>{t.symbol}</td>
                <td>{t.side}</td>
                <td>{t.entry_price}</td>
                <td>{t.exit_price}</td>
                <td>{t.net_pnl}</td>
                <td>{t.net_pct}</td>
                <td>{t.status}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
