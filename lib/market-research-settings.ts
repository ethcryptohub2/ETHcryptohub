import { decryptCredential } from './binance-credentials';
import { query } from './db';
import {
  ConfiguredMarketResearchProvider,
  type MarketResearchKeys,
  type MarketResearchProvider,
} from '../smartexit/apps/api/src/services/market-research';

interface StoredProviderKey {
  provider: keyof MarketResearchKeys;
  api_key_ciphertext: string;
}

const globalForMarketResearch = globalThis as typeof globalThis & {
  marketResearchProvider?: MarketResearchProvider;
  marketResearchCredentialFingerprint?: string;
};

export async function loadMarketResearchProvider(): Promise<MarketResearchProvider> {
  const result = await query<StoredProviderKey>(
    'SELECT provider, api_key_ciphertext FROM public.market_research_credentials',
  );
  const fingerprint = result.rows
    .map((row) => `${row.provider}:${row.api_key_ciphertext}`)
    .sort()
    .join('|');
  if (
    globalForMarketResearch.marketResearchProvider &&
    globalForMarketResearch.marketResearchCredentialFingerprint === fingerprint
  ) {
    return globalForMarketResearch.marketResearchProvider;
  }
  const keys: MarketResearchKeys = {
    glassnode: null,
    cryptopanic: null,
    coinglass: null,
  };
  for (const row of result.rows) keys[row.provider] = decryptCredential(row.api_key_ciphertext);
  const provider = new ConfiguredMarketResearchProvider(keys);
  globalForMarketResearch.marketResearchProvider = provider;
  globalForMarketResearch.marketResearchCredentialFingerprint = fingerprint;
  return provider;
}
