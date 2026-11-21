export type ReplayFillPair = {
  id: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  exit: number;
  quantity: number;
  enteredAt: number;
  exitedAt: number;
  funding: readonly { timestamp: number; markPrice: number; rate: number }[] | null;
};

export type ReplayCostAssumptions = { feeBps: number; slippageBps: number };

export function accountHistoricalReplay(
  fills: readonly ReplayFillPair[], assumptions: ReplayCostAssumptions, startingEquity: number,
) {
  const { feeBps, slippageBps } = assumptions;
  if (!Number.isFinite(startingEquity) || startingEquity <= 0 ||
      ![feeBps, slippageBps].every(value => Number.isFinite(value) && value >= 0 && value <= 1000)) {
    throw new RangeError('Invalid replay cost assumptions or starting equity.');
  }
  const ids = new Set<string>();
  const trades = fills.map(fill => {
    if (!fill.id || ids.has(fill.id) || !['LONG', 'SHORT'].includes(fill.side) ||
        ![fill.entry, fill.exit, fill.quantity].every(value => Number.isFinite(value) && value > 0) ||
        ![fill.enteredAt, fill.exitedAt].every(value => Number.isSafeInteger(value) && value >= 0) ||
        fill.exitedAt <= fill.enteredAt) throw new RangeError('Invalid or duplicate historical trade.');
    ids.add(fill.id);
    const direction = fill.side === 'LONG' ? 1 : -1;
    const slippedEntry = fill.entry * (1 + direction * slippageBps / 10_000);
    const slippedExit = fill.exit * (1 - direction * slippageBps / 10_000);
    const gross = direction * (fill.exit - fill.entry) * fill.quantity;
    const slippage = (fill.entry + fill.exit) * slippageBps / 10_000 * fill.quantity;
    const fees = (slippedEntry + slippedExit) * feeBps / 10_000 * fill.quantity;
    const settlements = new Set<number>();
    const funding = fill.funding?.reduce((total, event) => {
      if (!Number.isSafeInteger(event.timestamp) || event.timestamp <= fill.enteredAt ||
          event.timestamp >= fill.exitedAt || settlements.has(event.timestamp) ||
          !Number.isFinite(event.markPrice) || event.markPrice <= 0 || !Number.isFinite(event.rate)) {
        throw new RangeError('Invalid or ambiguous historical funding event.');
      }
      settlements.add(event.timestamp);
      return total - direction * event.rate * event.markPrice * fill.quantity;
    }, 0) ?? null;
    const net = funding === null ? null : gross - slippage - fees + funding;
    if (![gross, slippage, fees, net ?? 0].every(Number.isFinite)) throw new RangeError('Replay amounts exceed numeric limits.');
    return { id: fill.id, exitedAt: fill.exitedAt, gross, slippage, fees, funding, net };
  }).sort((left, right) => left.exitedAt - right.exitedAt || left.id.localeCompare(right.id));

  const unknownFundingTrades = trades.filter(trade => trade.net === null).length;
  if (unknownFundingTrades) return { trades, unknownFundingTrades, realized: null };
  const byExit = new Map<number, number>();
  let winning = 0, losing = 0, wins = 0, losses = 0;
  for (const trade of trades) {
    const net = trade.net!;
    if (net > 0) { winning += net; wins++; }
    if (net < 0) { losing -= net; losses++; }
    byExit.set(trade.exitedAt, (byExit.get(trade.exitedAt) ?? 0) + net);
  }
  let equity = startingEquity, peak = startingEquity, maxDrawdown = 0;
  const equityCurve = Array.from(byExit, ([timestamp, delta]) => {
    equity += delta;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    return { timestamp, equity };
  });
  if (![equity, winning, losing, maxDrawdown].every(Number.isFinite)) throw new RangeError('Portfolio amounts exceed numeric limits.');
  return { trades, unknownFundingTrades, realized: {
    net: equity - startingEquity,
    tradeCount: trades.length,
    wins,
    losses,
    breakEven: trades.length - wins - losses,
    winRate: trades.length ? wins / trades.length : null,
    expectancy: trades.length ? (equity - startingEquity) / trades.length : null,
    profitFactor: losing > 0 ? winning / losing : null,
    maxDrawdown,
    equityCurve,
  } };
}
