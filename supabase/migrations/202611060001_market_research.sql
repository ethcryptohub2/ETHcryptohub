CREATE TABLE IF NOT EXISTS public.market_research_credentials (
    provider VARCHAR(16) PRIMARY KEY CHECK (provider IN ('glassnode', 'cryptopanic', 'coinglass')),
    api_key_ciphertext TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.market_research_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.market_research_credentials FROM anon, authenticated;
