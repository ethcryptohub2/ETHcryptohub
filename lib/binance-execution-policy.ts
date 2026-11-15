export type BinanceSignalTargets = {
  tp1: string | null;
  tp2: string | null;
  tp3: string | null;
};

export function getFullPositionTakeProfit(targets: BinanceSignalTargets) {
  const target = Number(targets.tp3);
  if (typeof targets.tp3 !== 'string' || !Number.isFinite(target) || target <= 0) {
    throw new Error('A valid TP3 target is required for a full-position close.');
  }
  return targets.tp3;
}
