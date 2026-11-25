# SMARTEXIT — MULTI-EXCHANGE DEMO CONFIGURATION & INTEGRATION GUIDE

**Release Checkpoint:** v3.1.0-final-release-checkpoint  
**Target Architecture:** Multi-Exchange Autonomous Demo Execution  
**Working Branch:** \`functional-staging\`  
**Security Boundary:** Demo / Testnet Environments ONLY (Live Trading Locked Fail-Closed)  

---

## 1. Supported Exchanges Overview

SmartExit supports five primary derivatives exchanges for automated signal execution and lifecycle order protection. Each exchange adapter operates in an isolated Demo or Testnet environment:

| Exchange | Environment | Base REST URL | Required Credentials | Passphrase Needed |
| :--- | :--- | :--- | :--- | :--- |
| **Binance Futures** | \`DEMO\` | \`https://demo-fapi.binance.com\` | API Key + API Secret | No |
| **Bybit** | \`DEMO\` | \`https://api-demo.bybit.com\` | API Key + API Secret | No |
| **OKX** | \`DEMO\` | \`https://openapi.okx.com\` | API Key + API Secret + Passphrase | **Yes** |
| **Bitget** | \`DEMO\` | \`https://api.bitget.com\` | API Key + API Secret + Passphrase | **Yes** |
| **Gate.io** | \`TESTNET\` | \`https://api-testnet.gateapi.io/api/v4\` | API Key + API Secret | No |

---

## 2. Official Portal Links & Key Generation Steps

### 1. Binance Futures Mock / Demo
- **Official API Management Portal:** [https://testnet.binancefuture.com](https://testnet.binancefuture.com)
- **Account Type:** Binance Futures Testnet Account.
- **Setup Instructions:**
  1. Navigate to the Binance Futures Testnet portal and log in using your GitHub account or dedicated test credentials.
  2. Scroll down to the **API Key** section at the bottom of the page.
  3. Click **Generate API Key** $\to$ copy the generated API Key and Secret Key immediately.
  4. Ensure permissions include **Futures Trading** (Orders, Positions).
  5. Enter the credentials into SmartExit at \`/binance\` under the Binance Demo tab.

---

### 2. Bybit Demo Trading
- **Official API Management Portal:** [https://www.bybit.com/app/user/api-management](https://www.bybit.com/app/user/api-management)
- **Account Type:** Bybit Demo Trading Account (Unified Trading Account).
- **Setup Instructions:**
  1. Log in to Bybit and switch to **Demo Trading** mode via the top navigation or account menu.
  2. Navigate to **Account & Security** $\to$ **API Management**.
  3. Click **Create New Key** $\to$ select **System-generated API Keys**.
  4. Choose **Demo Trading API**.
  5. In permissions, check **Read-Write** and select **Contract / Unified Trading (Orders & Positions)**.
  6. **Never enable Withdrawals or Assets Transfer**.
  7. Copy the API Key and API Secret and save them into SmartExit at \`/binance\` under the Bybit Demo tab.

---

### 3. OKX Demo Trading
- **Official API Management Portal:** [https://www.okx.com/account/my-api](https://www.okx.com/account/my-api)
- **Account Type:** OKX Demo Account.
- **Setup Instructions:**
  1. Log in to OKX and switch to **Demo Trading** (Simulator) from the profile dropdown.
  2. Navigate to your Profile icon $\to$ **API** $\to$ click **Create V5 API Key**.
  3. Select **Demo Trading**.
  4. Set an API Name (e.g. \`SmartExit-Demo\`).
  5. **Passphrase:** Enter a custom Passphrase (must be 8–32 characters including numbers, uppercase, lowercase, and symbols). **Remember this passphrase**, as it is required alongside the API Key and Secret.
  6. Under Permissions, select **Read** and **Trade**.
  7. Copy the API Key, Secret Key, and Passphrase and enter them into SmartExit.

---

### 4. Bitget Demo Trading
- **Official API Management Portal:** [https://www.bitget.com/account/newapi](https://www.bitget.com/account/newapi)
- **Account Type:** Bitget Simulated / Demo Trading Account.
- **Setup Instructions:**
  1. Log in to Bitget and switch to **Demo Trading** (Futures Demo).
  2. Navigate to your Profile $\to$ **API Management** $\to$ **Create API Key**.
  3. Choose **System-generated Key**.
  4. Enter a Note and specify your **Passphrase** (8–32 characters).
  5. Select Permissions: **Futures / USDT-M Futures Trading (Orders, Positions)**.
  6. Ensure IP restriction is set to **No IP restrictions (linking IP)** for testnet environments or specify your VPS static IP.
  7. Save and enter API Key, Secret, and Passphrase into SmartExit.

---

### 5. Gate.io Testnet
- **Official API Management Portal:** [https://www.gate.io/myaccount/api-key-manage](https://www.gate.io/myaccount/api-key-manage)
- **Account Type:** Gate.io Testnet Subaccount.
- **Setup Instructions:**
  1. Access the Gate.io Testnet interface at [https://www.gate.io/testnet](https://www.gate.io/testnet).
  2. Navigate to **API Management** $\to$ **Create API Key**.
  3. Select **Futures Testnet API Key**.
  4. Select **Futures Trading** permissions (Orders, Positions, Balances).
  5. Copy the generated Key and Secret and save into SmartExit under Gate.io Testnet.

---

## 3. Credential Security & Encryption Architecture

SmartExit implements military-grade security to ensure credentials are never exposed or compromised:

1. **Authenticated Encryption at Rest (AES-256-GCM):**
   - Implemented in [lib/binance-credentials.ts](file:///C:/Users/91797/Ethcryptohub/lib/binance-credentials.ts).
   - Encrypted with a 256-bit cryptographic key (\`process.env.BINANCE_CREDENTIALS_KEY\`).
   - Uses a unique 12-byte random initialization vector (nonce) per encryption:
     $$\text{Stored Format} = \text{nonce}_{\text{hex}} \mathbin{\Vert} \text{authTag}_{\text{hex}} \mathbin{\Vert} \text{ciphertext}_{\text{hex}}$$
   - Authenticated tag verification prevents any ciphertext tampering.

2. **Zero Plaintext Storage:**
   - Database tables \`exchange_api_credentials\` and \`binance_api_credentials\` store ONLY \`api_key_ciphertext\`, \`api_secret_ciphertext\`, and \`passphrase_ciphertext\`.
   - Only the last 4 characters (\`api_key_suffix\`) are stored in plaintext for account identification in the UI.

3. **Row Level Security (RLS):**
   - 100% of exchange credential tables enforce PostgreSQL RLS. Users can only query and mutate their own authenticated credentials (\`user_id = auth.uid()\`).

4. **Fail-Closed Live Trading Prevention:**
   - Real-money live trading endpoints are permanently locked with HTTP 403 Forbidden.
   - \`assertExchangeEnabledForCustomer()\` verifies that any attempt to connect or execute on \`LIVE\` is rejected fail-closed.

---

## 4. Multi-Exchange Execution Switches & Parallel Fanout

SmartExit allows individual configuration and execution controls:
- **Individual ON/OFF Switches:** Each exchange has an independent toggle stored in \`user_exchange_preferences\`.
- **Parallel Dispatch Pipeline:** When a scanner signal qualifies and automatic trading is triggered, \`dispatchSignalAcrossEnabledExchanges()\` fans out in parallel across ALL enabled and authorized exchanges.
- **Independent Balance & Risk Isolation:** An order rejection on one exchange (e.g. insufficient testnet margin) never halts or invalidates orders dispatched to other exchanges.
