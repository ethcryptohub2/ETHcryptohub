# Archived API

Paper-trading and wallet routes are disabled by default and return `410 Gone`. The standalone API only retains the public market-data and technical-scanner endpoints for internal compatibility. The ETHcryptohub product does not expose this service as a paper-trading feature.

The legacy route implementation remains in source for historical tests. Do not deploy it with `paperTradingEnabled` set to `true`.
