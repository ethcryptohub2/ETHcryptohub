export type StrategyId = 'STANDARD' | 'HIGH_RISK_SCALPING';
export type SignalScannerType = 'STANDARD' | 'HIGH_RISK';

export function strategyForSignal(scannerType: SignalScannerType): StrategyId {
  return scannerType === 'HIGH_RISK' ? 'HIGH_RISK_SCALPING' : 'STANDARD';
}

export function assertSignalStrategy(scannerType: SignalScannerType, strategy: StrategyId) {
  const expected = strategyForSignal(scannerType);
  if (strategy !== expected) {
    throw new Error(`Signal strategy mismatch: ${scannerType} signals must route to ${expected}.`);
  }
}

export function assertStrategyDestination(
  profile: { exchange: string; environment: string },
  exchange: string,
  environment: string,
) {
  if (profile.exchange !== exchange || profile.environment !== environment) {
    throw new Error('Signal execution destination does not match the strategy profile.');
  }
}
