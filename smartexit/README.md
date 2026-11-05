# Archived SmartExit workspace

The paper-trading and wallet features are no longer part of the ETHcryptohub product. The main app does not expose the SmartExit page or API bridge, and the standalone API returns `410 Gone` for paper-trading and wallet routes by default. Its market-data scanner remains informational and does not size positions or depend on a paper account.

The legacy source and tests remain in this folder for reference. Do not deploy the previous SmartExit web app or configure its API as a user-facing service.
