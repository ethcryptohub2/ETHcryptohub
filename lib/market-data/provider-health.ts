import type {
  AnyProviderId,
  ProviderCapabilities,
  ProviderCircuitState,
  ProviderHealthSnapshot,
} from './provider-types';

export class ProviderUnavailableError extends Error {
  readonly provider: AnyProviderId;
  readonly statusCode: number | null;
  readonly cooldownUntil: number | null;

  constructor(
    provider: AnyProviderId,
    message: string,
    statusCode: number | null = null,
    cooldownUntil: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.provider = provider;
    this.statusCode = statusCode;
    this.cooldownUntil = cooldownUntil;
  }
}

export class ProviderHealthTracker {
  readonly id: AnyProviderId;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;

  private enabled = true;
  private configured = true;
  private circuitState: ProviderCircuitState = 'CLOSED';
  private cooldownUntil: number | null = null;
  private consecutiveFailures = 0;
  private lastSuccessAt: number | null = null;
  private lastErrorAt: number | null = null;
  private lastErrorSanitized: string | null = null;

  private dailyLimit: number | null;
  private dailyUsed = 0;
  private dailyWindowStart = 0;

  constructor(options: {
    id: AnyProviderId;
    label: string;
    capabilities: ProviderCapabilities;
    dailyLimit?: number | null;
    enabled?: boolean;
    configured?: boolean;
  }) {
    this.id = options.id;
    this.label = options.label;
    this.capabilities = options.capabilities;
    this.dailyLimit = options.dailyLimit ?? null;
    this.enabled = options.enabled ?? true;
    this.configured = options.configured ?? true;
  }

  setAvailability(enabled: boolean, configured: boolean): void {
    this.enabled = enabled;
    this.configured = configured;
  }

  private rollDailyWindowIfNeeded(now: number): void {
    const dayMs = 24 * 60 * 60_000;
    if (this.dailyWindowStart === 0 || now - this.dailyWindowStart >= dayMs) {
      this.dailyWindowStart = now;
      this.dailyUsed = 0;
    }
  }

  hasQuota(cost = 1, now = Date.now()): boolean {
    this.rollDailyWindowIfNeeded(now);
    if (this.dailyLimit === null) return true;
    return this.dailyUsed + cost <= this.dailyLimit;
  }

  recordQuotaUse(cost = 1, now = Date.now()): void {
    this.rollDailyWindowIfNeeded(now);
    this.dailyUsed += cost;
  }

  exportQuotaState(now = Date.now()): { dailyUsed: number; dailyWindowStart: number } {
    this.rollDailyWindowIfNeeded(now);
    return { dailyUsed: this.dailyUsed, dailyWindowStart: this.dailyWindowStart };
  }

  hydrateQuotaState(dailyUsed: number, dailyWindowStart: number, now = Date.now()): void {
    const dayMs = 24 * 60 * 60_000;
    if (dailyWindowStart > 0 && now - dailyWindowStart < dayMs) {
      this.dailyWindowStart = dailyWindowStart;
      this.dailyUsed = Math.max(0, Math.floor(dailyUsed));
    }
  }

  isEligible(now = Date.now()): boolean {
    if (!this.enabled || !this.configured) return false;
    if (!this.hasQuota(1, now)) return false;
    if (this.circuitState === 'OPEN') {
      if (this.cooldownUntil !== null && now >= this.cooldownUntil) {
        this.circuitState = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(now = Date.now()): void {
    this.circuitState = 'CLOSED';
    this.cooldownUntil = null;
    this.consecutiveFailures = 0;
    this.lastSuccessAt = now;
    this.lastErrorSanitized = null;
  }

  recordFailure(
    statusCode: number | null,
    reason: string,
    retryAfterMs: number | null = null,
    now = Date.now(),
  ): ProviderUnavailableError {
    this.consecutiveFailures += 1;
    this.lastErrorAt = now;
    this.lastErrorSanitized = reason.slice(0, 180);

    // Rate-limit / auth / ban errors immediately open the circuit
    const isRateOrAuth = statusCode === 418 || statusCode === 429 || statusCode === 401 || statusCode === 403;
    // Hysteresis: open after 2 consecutive transient errors or 1 rate/auth error
    if (isRateOrAuth || this.consecutiveFailures >= 2) {
      const baseMs = statusCode === 418 ? 180_000 : statusCode === 401 || statusCode === 403 ? 300_000 : 60_000;
      const exponent = Math.min(4, this.consecutiveFailures - 1);
      const computedMs = Math.min(15 * 60_000, baseMs * 2 ** exponent);
      const cooldownMs = retryAfterMs !== null ? Math.max(retryAfterMs, 15_000) : computedMs;
      this.circuitState = 'OPEN';
      this.cooldownUntil = now + cooldownMs;
    }

    return new ProviderUnavailableError(this.id, this.lastErrorSanitized, statusCode, this.cooldownUntil);
  }

  syncExternalCooldown(state: ProviderCircuitState, cooldownUntil: number | null, reason: string | null): void {
    this.circuitState = state;
    this.cooldownUntil = cooldownUntil;
    this.lastErrorSanitized = reason;
  }

  reset(): void {
    this.circuitState = 'CLOSED';
    this.cooldownUntil = null;
    this.consecutiveFailures = 0;
    this.lastErrorAt = null;
    this.lastErrorSanitized = null;
    this.dailyUsed = 0;
    this.dailyWindowStart = 0;
  }

  snapshot(now = Date.now(), minuteWeightUsed = 0, minuteWeightLimit: number | null = null): ProviderHealthSnapshot {
    this.rollDailyWindowIfNeeded(now);
    let effectiveState: ProviderCircuitState = this.circuitState;
    if (!this.enabled) effectiveState = 'DISABLED';
    else if (!this.configured) effectiveState = 'UNCONFIGURED';
    else if (this.circuitState === 'OPEN' && this.cooldownUntil !== null && now >= this.cooldownUntil) {
      effectiveState = 'HALF_OPEN';
    }

    return {
      id: this.id,
      label: this.label,
      enabled: this.enabled,
      configured: this.configured,
      circuitState: effectiveState,
      cooldownUntil: this.cooldownUntil,
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorSanitized: this.lastErrorSanitized,
      quota: {
        dailyLimit: this.dailyLimit,
        dailyUsed: this.dailyUsed,
        minuteWeightLimit,
        minuteWeightUsed,
        resetAt: this.dailyWindowStart > 0 ? this.dailyWindowStart + 24 * 60 * 60_000 : null,
      },
      capabilities: this.capabilities,
    };
  }
}
