# Demo and Testnet exchange support

Exchange API availability does not mean SmartExit has a production-ready adapter. Every unimplemented capability remains disabled in `lib/exchanges/registry.ts`; Demo/Testnet is never inferred from a Live endpoint.

## Verified provider environments

| Provider | Official environment and base | Authentication / account requirements | SmartExit status |
| --- | --- | --- | --- |
| Binance Futures | Demo: `https://demo-fapi.binance.com`; separate from Live. | Dedicated Demo API key and secret; fixed environment-bound client. | Demo adapter, protected Admin Demo service, and mocked lifecycle tests exist. Remote use remains blocked until the Staging migrations and checks are approved. |
| Bybit V5 | Demo: `https://api-demo.bybit.com`; separate from Testnet (`https://api-testnet.bybit.com`) and mainnet. Demo keys must be created in the Demo account module. | V5 HMAC authentication. The official Demo API exposes market, trade, position, wallet, and trading-stop endpoints, with some API exclusions and default rate limits. | Generic Demo adapter plus Admin-scoped read/preflight port and mocks exist. Entry, protection, close, and reconciliation remain disabled because the required TP1/TP2 full-position lifecycle is not verified. |
| OKX V5 | Demo uses the official REST host `https://openapi.okx.com`; Demo is selected by the required `x-simulated-trading: 1` header, not by using a different host. | HMAC-SHA256/Base64 private-request signature; API key, secret, and passphrase. Set the required account mode in the web/app before using its trading APIs. | Mocked read-only adapter supports connection/account mode, balance, linear SWAP metadata, and net-mode positions. Entry, protection, close, and reconciliation remain disabled. Do not make private calls without the Demo header. |
| Bitget | Official Demo material exists on API host `https://api.bitget.com`; it is not a separate Testnet host. | Private APIs use signed requests; Demo requirements for the futures account, contracts, and positions endpoints remain unverified across API generations. | Entirely unsupported: no requests are enabled. Keep all capability flags false until official endpoint-level Demo requirements are confirmed. |
| Gate.io Futures | Futures Testnet: `https://api-testnet.gateapi.io/api/v4`; separate from Live. This is Testnet, not Demo. | Gate API v4 HMAC-SHA512 signing with Testnet-specific credentials/account. | Mocked read-only Testnet adapter supports connection/account, USDT futures contract metadata, and positions. Entry, protection, close, and reconciliation remain unavailable. |

## Capability and release boundary

Current release status (2026-11-18): the provider-neutral Admin backend is
connected locally, including a mock-only Bybit staged lifecycle. The real Bybit
adapter is tested through the Admin service. All remote execution remains
disabled; TP2 replacement and native trailing activation verification remain
unsupported. See `MASTER-STAGING-RELEASE-REVIEW.md` for current evidence. Earlier
read-only descriptions below describe the prior baseline.

- The unified Admin Demo Console lists all five providers and preserves the Binance Admin console. Only Binance has the connected isolated Admin lifecycle.
- Bybit, OKX, and Gate have mocked read-only adapters; none has a connected generic Admin service or an enabled lifecycle. Bitget remains entirely unsupported until its futures Demo endpoints are verified.
- Bybit's API documents position trading-stop and trailing-stop functionality. That API availability alone does not establish SmartExit's TP1/TP2/TP3 lifecycle safety.
- No adapter may silently fall back to a Live host, omit a provider's Demo/Testnet selector header, or downgrade unsupported protection.
- The staged database chain remains pending. Do not use any Admin Demo flow until Staging migration application and post-migration verification are separately approved.

## Official documentation

- [Binance Futures API](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info)
- [Bybit V5 Demo Trading](https://bybit-exchange.github.io/docs/v5/demo)
- [Bybit V5 Set Trading Stop](https://bybit-exchange.github.io/docs/v5/position/trading-stop)
- [OKX V5 API documentation](https://www.okx.com/docs-v5/en/)
- [Bitget Demo Trading API documentation](https://www.bitget.com/api-doc/common/demotrading/restapi)
- [Bitget Classic Futures Place Order](https://www.bitget.com/docs/catalog/classic-contract-trade/classic-contract-trade#place-order)
- [Bitget UTA Quick Start](https://www.bitget.com/docs/uta/quick-start.md)
- [Gate.io API v4 documentation and access URLs](https://www.gate.com/docs/developers/apiv4/en/)
