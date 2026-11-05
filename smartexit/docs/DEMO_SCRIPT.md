# SmartExit demo script

1. Start the app with the Windows setup commands in the README and open `http://localhost:5173`.
2. Show that the app defaults to NEAR testnet and that the wallet prompt asks only for a NEP-413 login-message signature, not a transaction or dApp contract.
3. Connect Meteor Wallet on NEAR testnet, choose the account, and approve the NEP-413 sign-in message. Point out that the returned account ID scopes the private paper portfolio.
4. Create a paper position and show the PAPER MODE disclaimer. If demonstrating exits, use the manual simulated-price control and label each price as a test input, not a market fill.
5. Sign out and sign back in to show the same NEAR account retrieves its saved paper data.
6. Open NEAR Intents and explain `NOT_CONFIGURED`: the official 1Click API has no testnet, and swaps remain disabled rather than requesting mainnet funds during this paper demo.
7. Run `npm.cmd test`, `npm.cmd run lint`, `npm.cmd run typecheck`, and `npm.cmd run build`; report their actual outcomes.

Visible disclaimer: balances, trades, exits, and P&L are simulated. The NEAR wallet is used only to verify account ownership; the demo sends no wallet transactions or live exchange orders. P&L excludes fees, funding, slippage, liquidation, and contract multipliers.
