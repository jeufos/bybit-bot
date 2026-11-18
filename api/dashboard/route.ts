import { neon } from "@neondatabase/serverless";
import { NextResponse } from "next/server";

const sql = neon(process.env.DATABASE_URL!);

export async function GET() {
  const open = await sql`
    SELECT * FROM trades
    WHERE status = 'OPEN'
    ORDER BY id DESC
  `;

  const closed = await sql`
    SELECT * FROM trades
    WHERE status = 'CLOSED'
    ORDER BY id DESC
  `;

  const wins = closed.filter((t) => Number(t.net_pnl) > 0).length;
  const winRate = closed.length
    ? (wins / closed.length) * 100
    : 0;

  const totalNetPnl = closed.reduce(
    (acc, t) => acc + Number(t.net_pnl || 0),
    0
  );

  const bySymbolMap: Record<
    string,
    { symbol: string; trades: number; netPnl: number }
  > = {};

  closed.forEach((t) => {
    if (!bySymbolMap[t.symbol]) {
      bySymbolMap[t.symbol] = {
        symbol: t.symbol,
        trades: 0,
        netPnl: 0,
      };
    }

    bySymbolMap[t.symbol].trades += 1;
    bySymbolMap[t.symbol].netPnl += Number(t.net_pnl || 0);
  });

  const bySymbol = Object.values(bySymbolMap).sort(
    (a, b) => b.netPnl - a.netPnl
  );

  return NextResponse.json({
    openPositions: open,
    closedTrades: closed,
    stats: {
      totalClosed: closed.length,
      winRate: winRate.toFixed(2) + "%",
      totalNetPnl: totalNetPnl.toFixed(2),
      bySymbol,
    },
  });
}
