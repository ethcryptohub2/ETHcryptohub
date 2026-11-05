export type NearIntentsStatus = 'NOT_CONFIGURED' | 'CONFIGURED' | 'CONNECTED' | 'ERROR';

export interface NearIntentsAdapter {
  status(): { status: NearIntentsStatus; message: string; swapsEnabled: false };
  tokens(): { status: NearIntentsStatus; tokens: never[] };
}

export function createNearIntentsAdapter(): NearIntentsAdapter {
  return {
    status: () => ({
      status: 'NOT_CONFIGURED',
      message:
        'NEAR Intents has no testnet. SmartExit is paper-only, so mainnet swaps remain disabled until a separately reviewed wallet-transaction integration is approved and configured.',
      swapsEnabled: false,
    }),
    tokens: () => ({ status: 'NOT_CONFIGURED', tokens: [] }),
  };
}
