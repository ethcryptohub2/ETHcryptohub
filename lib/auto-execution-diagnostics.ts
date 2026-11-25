/**
 * SmartExit Auto-Execution Diagnostics & Reason Codes
 *
 * Provides standardized diagnostic codes for automatic Demo trading execution
 * across all connected exchanges (Binance, Bybit, OKX, Bitget, Gate.io).
 */

export type AutoExecutionReasonCode =
  | 'READY_TO_DISPATCH'
  | 'EXECUTED_DEMO'
  | 'WORKER_OFFLINE'
  | 'SIGNAL_NOT_READY'
  | 'ENTRY_EXPIRED'
  | 'AUTOMATIC_MODE_DISABLED'
  | 'EXCHANGE_DISABLED'
  | 'PROVIDER_DISABLED'
  | 'DEMO_CREDENTIALS_MISSING'
  | 'DEMO_CREDENTIALS_INVALID'
  | 'ADAPTER_INCOMPLETE'
  | 'DATABASE_SCHEMA_MISSING'
  | 'INSUFFICIENT_AVAILABLE_BALANCE'
  | 'MINIMUM_ORDER_NOTIONAL'
  | 'RISK_LIMIT_EXCEEDED'
  | 'DUPLICATE_EXECUTION'
  | 'EMERGENCY_STOP_ACTIVE'
  | 'EXCHANGE_ORDER_REJECTED'
  | 'PROTECTION_INSTALLATION_FAILED'
  | 'LIVE_TRADING_LOCKED';

export interface DiagnosticMetadata {
  code: AutoExecutionReasonCode;
  category: 'ARMED' | 'EXECUTED' | 'BLOCKED' | 'OFFLINE' | 'LOCKED';
  badgeLabel: string;
  badgeVariant: 'success' | 'warning' | 'error' | 'muted';
  title: string;
  description: string;
  actionHint: string;
}

export const AUTO_EXECUTION_DIAGNOSTICS: Record<AutoExecutionReasonCode, DiagnosticMetadata> = {
  READY_TO_DISPATCH: {
    code: 'READY_TO_DISPATCH',
    category: 'ARMED',
    badgeLabel: '⚡ ARMED (AUTO)',
    badgeVariant: 'success',
    title: 'Ready for Auto-Dispatch',
    description: 'Signal meets all algorithmic confluence criteria and execution preconditions are satisfied. Automated Demo order will be dispatched on the next worker cycle.',
    actionHint: 'Automated 24/7 background worker is monitoring this signal for immediate Demo order dispatch.',
  },
  EXECUTED_DEMO: {
    code: 'EXECUTED_DEMO',
    category: 'EXECUTED',
    badgeLabel: '✓ EXECUTED (DEMO)',
    badgeVariant: 'success',
    title: 'Demo Order Executed & Protected',
    description: 'Order was submitted and filled on the connected exchange Demo environment with active Stop Loss and Take Profit protection.',
    actionHint: 'View active positions and live PnL in the Positions and Exchange tabs.',
  },
  WORKER_OFFLINE: {
    code: 'WORKER_OFFLINE',
    category: 'OFFLINE',
    badgeLabel: '⚠ WORKER OFFLINE',
    badgeVariant: 'warning',
    title: 'Background Trading Worker Offline',
    description: 'The 24/7 automated trading worker process is not running or heartbeat is stale (>90s). Signals cannot be dispatched automatically while the worker is offline.',
    actionHint: 'Start the worker on your Windows machine by running: powershell -File scripts/start-local-worker.ps1',
  },
  SIGNAL_NOT_READY: {
    code: 'SIGNAL_NOT_READY',
    category: 'BLOCKED',
    badgeLabel: '⏳ NOT READY',
    badgeVariant: 'muted',
    title: 'Signal Awaiting Confluence Confirmation',
    description: 'Confluence score is below the required threshold (Score < 60) or technical indicators (EMA, RSI, SuperTrend) have not confirmed alignment.',
    actionHint: 'The scanner continuously analyzes candle closes and will promote this symbol to ENTRY READY once all criteria align.',
  },
  ENTRY_EXPIRED: {
    code: 'ENTRY_EXPIRED',
    category: 'BLOCKED',
    badgeLabel: '✕ ENTRY EXPIRED',
    badgeVariant: 'muted',
    title: 'Entry Window Expired or Target Reached',
    description: 'The signal validity window has elapsed or market price has already touched Take Profit 1 (TP1), making a new entry invalid.',
    actionHint: 'Awaiting the next technical setup. New orders are blocked to prevent chasing extended moves.',
  },
  AUTOMATIC_MODE_DISABLED: {
    code: 'AUTOMATIC_MODE_DISABLED',
    category: 'BLOCKED',
    badgeLabel: '⚙ AUTO DISABLED',
    badgeVariant: 'warning',
    title: 'Automatic Execution Mode Disabled',
    description: 'Strategy execution mode is set to CONFIRM (manual click required) or auto-trading switch is toggled OFF.',
    actionHint: 'Enable automatic trading in Strategy Settings (switch Execution Mode to AUTOMATIC).',
  },
  EXCHANGE_DISABLED: {
    code: 'EXCHANGE_DISABLED',
    category: 'BLOCKED',
    badgeLabel: '⛔ EXCHANGE OFF',
    badgeVariant: 'warning',
    title: 'Exchange Execution Switch Disabled',
    description: 'Execution switch for this exchange is toggled OFF in the Multi-Exchange Trading configuration.',
    actionHint: 'Enable the exchange switch in the Exchange Connections panel to allow parallel auto-execution.',
  },
  PROVIDER_DISABLED: {
    code: 'PROVIDER_DISABLED',
    category: 'BLOCKED',
    badgeLabel: '⚠ FEED PAUSED',
    badgeVariant: 'warning',
    title: 'Market Data Provider Inactive',
    description: 'Market data feed for this exchange is paused or experiencing connectivity latency.',
    actionHint: 'Check exchange feed connectivity in Admin Diagnostics.',
  },
  DEMO_CREDENTIALS_MISSING: {
    code: 'DEMO_CREDENTIALS_MISSING',
    category: 'BLOCKED',
    badgeLabel: '🔑 NO DEMO KEYS',
    badgeVariant: 'warning',
    title: 'Exchange Demo API Keys Missing',
    description: 'No authenticated Demo or Testnet API credentials have been configured for this exchange.',
    actionHint: 'Navigate to Exchanges -> Connect Exchange to enter your official Demo/Testnet API key and secret.',
  },
  DEMO_CREDENTIALS_INVALID: {
    code: 'DEMO_CREDENTIALS_INVALID',
    category: 'BLOCKED',
    badgeLabel: '❌ INVALID KEYS',
    badgeVariant: 'error',
    title: 'Demo API Authentication Failed',
    description: 'The exchange Demo/Testnet API rejected the stored credentials with an authentication error (HTTP 401/403).',
    actionHint: 'Verify that your API key, secret, and passphrase (for OKX/Bitget) are active on the exchange Demo portal.',
  },
  ADAPTER_INCOMPLETE: {
    code: 'ADAPTER_INCOMPLETE',
    category: 'BLOCKED',
    badgeLabel: '🔧 ADAPTER PENDING',
    badgeVariant: 'warning',
    title: 'Exchange Order Adapter Incomplete',
    description: 'Automated order placement adapter is under maintenance or pending endpoint capability approval.',
    actionHint: 'Binance and Bybit Demo adapters are fully verified; other adapters are being progressively activated.',
  },
  DATABASE_SCHEMA_MISSING: {
    code: 'DATABASE_SCHEMA_MISSING',
    category: 'BLOCKED',
    badgeLabel: '🗄 SCHEMA PENDING',
    badgeVariant: 'error',
    title: 'Database Migration Required',
    description: 'Required database schema or execution tables are missing from the active database.',
    actionHint: 'Run pending database migrations in the verified Staging Supabase environment.',
  },
  INSUFFICIENT_AVAILABLE_BALANCE: {
    code: 'INSUFFICIENT_AVAILABLE_BALANCE',
    category: 'BLOCKED',
    badgeLabel: '💰 LOW BALANCE',
    badgeVariant: 'warning',
    title: 'Insufficient Demo Margin Balance',
    description: 'Available Demo USDT balance is below the required initial margin for this trade size and leverage.',
    actionHint: 'Reset or replenish your testnet wallet balance via the exchange Demo faucet.',
  },
  MINIMUM_ORDER_NOTIONAL: {
    code: 'MINIMUM_ORDER_NOTIONAL',
    category: 'BLOCKED',
    badgeLabel: '📉 BELOW MIN NOTIONAL',
    badgeVariant: 'warning',
    title: 'Order Size Below Exchange Minimum',
    description: 'Calculated order notional is below the exchange mandatory minimum (typically 5–10 USDT).',
    actionHint: 'Increase fixed notional or risk percentage in Strategy Settings.',
  },
  RISK_LIMIT_EXCEEDED: {
    code: 'RISK_LIMIT_EXCEEDED',
    category: 'BLOCKED',
    badgeLabel: '🛡 RISK LIMIT HIT',
    badgeVariant: 'warning',
    title: 'Risk Management Limit Exceeded',
    description: 'Maximum concurrent open positions (limit: 5) or maximum daily loss threshold reached.',
    actionHint: 'Risk governor prevents new order submissions until existing positions close.',
  },
  DUPLICATE_EXECUTION: {
    code: 'DUPLICATE_EXECUTION',
    category: 'BLOCKED',
    badgeLabel: '🔄 DUPLICATE ORDER',
    badgeVariant: 'muted',
    title: 'Execution Already Exists for This Signal',
    description: 'An active or pending execution record already exists for this pair and signal on this exchange.',
    actionHint: 'Idempotency gate prevents accidental duplicate orders for the same technical setup.',
  },
  EMERGENCY_STOP_ACTIVE: {
    code: 'EMERGENCY_STOP_ACTIVE',
    category: 'BLOCKED',
    badgeLabel: '🛑 EMERGENCY STOP',
    badgeVariant: 'error',
    title: 'Emergency Kill Switch Active',
    description: 'Emergency stop was triggered manually or via kill-switch file. All automated order routing is halted fail-closed.',
    actionHint: 'Clear the emergency stop flag in Admin Worker Supervision or delete the storage/demo-worker/kill-switch file.',
  },
  EXCHANGE_ORDER_REJECTED: {
    code: 'EXCHANGE_ORDER_REJECTED',
    category: 'BLOCKED',
    badgeLabel: '❌ ORDER REJECTED',
    badgeVariant: 'error',
    title: 'Exchange Order Submission Rejected',
    description: 'Remote exchange API returned an order rejection error (price band, tick size, or leverage limit violation).',
    actionHint: 'Check the error message in Execution History for exchange-specific rejection details.',
  },
  PROTECTION_INSTALLATION_FAILED: {
    code: 'PROTECTION_INSTALLATION_FAILED',
    category: 'BLOCKED',
    badgeLabel: '⚠ PROTECTION FAILED',
    badgeVariant: 'error',
    title: 'Protective Order Placement Failed',
    description: 'Entry order filled but subsequent Stop Loss or Take Profit conditional order failed to install.',
    actionHint: 'SmartExit safety policy triggers an immediate emergency market close to avoid an unprotected open position.',
  },
  LIVE_TRADING_LOCKED: {
    code: 'LIVE_TRADING_LOCKED',
    category: 'LOCKED',
    badgeLabel: '🔒 LIVE LOCKED',
    badgeVariant: 'error',
    title: 'Live Real-Money Trading Locked',
    description: 'Real-money live execution is locked fail-closed (HTTP 403 Forbidden). Platform is restricted to authenticated exchange Demo APIs.',
    actionHint: 'All automated and manual trading routes operate exclusively in exchange Demo/Testnet environments.',
  },
};

export interface DiagnosticEvaluationInput {
  status: string;
  side: string;
  hasSetup: boolean;
  score?: number | null;
  entryPrice?: number | null;
  currentMarkPrice?: number | null;
  tp1?: number | null;
  entryZoneLow?: number | null;
  entryZoneHigh?: number | null;
  isExpired?: boolean;
  environment?: 'DEMO' | 'TESTNET' | 'LIVE';
  workerActive?: boolean;
  autoTradingEnabled?: boolean;
  exchangeEnabled?: boolean;
  hasCredentials?: boolean;
  emergencyStop?: boolean;
  existingExecution?: boolean;
}

export function evaluateSignalAutoExecution(input: DiagnosticEvaluationInput): DiagnosticMetadata {
  if (input.environment === 'LIVE') {
    return AUTO_EXECUTION_DIAGNOSTICS.LIVE_TRADING_LOCKED;
  }
  if (input.emergencyStop) {
    return AUTO_EXECUTION_DIAGNOSTICS.EMERGENCY_STOP_ACTIVE;
  }
  if (input.existingExecution) {
    return AUTO_EXECUTION_DIAGNOSTICS.EXECUTED_DEMO;
  }
  if (!input.hasSetup || input.status !== 'READY' || input.side === 'WAIT') {
    return AUTO_EXECUTION_DIAGNOSTICS.SIGNAL_NOT_READY;
  }
  if (input.isExpired) {
    return AUTO_EXECUTION_DIAGNOSTICS.ENTRY_EXPIRED;
  }
  if (input.currentMarkPrice && input.tp1) {
    const isLong = input.side === 'LONG';
    if ((isLong && input.currentMarkPrice >= input.tp1) || (!isLong && input.currentMarkPrice <= input.tp1)) {
      return AUTO_EXECUTION_DIAGNOSTICS.ENTRY_EXPIRED;
    }
  }
  if (input.workerActive === false) {
    return AUTO_EXECUTION_DIAGNOSTICS.WORKER_OFFLINE;
  }
  if (input.autoTradingEnabled === false) {
    return AUTO_EXECUTION_DIAGNOSTICS.AUTOMATIC_MODE_DISABLED;
  }
  if (input.exchangeEnabled === false) {
    return AUTO_EXECUTION_DIAGNOSTICS.EXCHANGE_DISABLED;
  }
  if (input.hasCredentials === false) {
    return AUTO_EXECUTION_DIAGNOSTICS.DEMO_CREDENTIALS_MISSING;
  }

  return AUTO_EXECUTION_DIAGNOSTICS.READY_TO_DISPATCH;
}
