# Email OTP setup

ETHcryptohub verifies email ownership with a six-digit, one-time code. Codes expire after ten
minutes, are stored as password hashes, and allow at most five incorrect attempts before a
15-minute lockout. PHP's unauthenticated `mail()` function is not used.

For an existing MySQL database, apply [email_verification_codes.sql](./email_verification_codes.sql)
and [email_verification_requests.sql](./email_verification_requests.sql) before enabling signup/resend.
Fresh local SQLite databases create both tables automatically.

Configure these environment variables for the PHP server:

- `RESEND_API_KEY`: private Resend API key with permission to send email.
- `MAIL_FROM`: an email address on a domain verified with Resend. Use the address only, without a display name.
- `CURL_CA_BUNDLE` (optional): path to a readable PEM CA bundle if PHP's cURL installation has no system trust store.

The sender must be verified by Resend. A personal `@gmail.com` sender is not an eligible sender domain;
verify a domain you control in Resend and use an address on that domain. No public application URL is
needed for OTP delivery. When no CA bundle is configured, loopback development also checks for
`%LOCALAPPDATA%\ETHcryptohub\cacert.pem`; TLS peer and hostname verification remain enabled.

On a loopback-only local server with no `RESEND_API_KEY`, signup and resend show a development-only
OTP on the page instead of sending email. This is only for local testing and does not prove mailbox
ownership. For actual delivery, configure Resend and restart the PHP server so it receives the variables.
Resend handoff success does not guarantee inbox placement; check Resend delivery events and the recipient's
spam folder.

On Windows, dot-source `. .\configure-email.ps1` from the project directory to enter the API key through a
hidden prompt and save the settings to the current Windows user's and current PowerShell process's
environment. The API key is not printed. Restart the PHP server from that same PowerShell window afterward;
already-running server processes do not inherit changed environment variables.

After configuration, test delivery without changing any account:

```powershell
$php = "C:\Users\91797\AppData\Local\ETHcryptohub\php\php.exe"
& $php -d "extension_dir=C:\Users\91797\AppData\Local\ETHcryptohub\php\ext" `
    -d extension=curl -d extension=openssl `
    .\email-delivery-check.php your-inbox@example.com
```

The CLI check reports which non-secret settings are missing without printing the API key. It sends a
test email only when the Resend API key, verified sender, and cURL are ready. A successful result means
Resend accepted the request, not that it reached the inbox.

## Binance credential encryption

Before using [binance-settings.php](./binance-settings.php), set `BINANCE_CREDENTIALS_KEY` in the PHP
server environment to a randomly generated 32-byte key encoded as 64 hexadecimal characters. Generate
one with the PHP runtime:

```powershell
$php = "C:\path\to\php.exe"
$key = & $php -r "echo bin2hex(random_bytes(32));"
[Environment]::SetEnvironmentVariable("BINANCE_CREDENTIALS_KEY", $key, "User")
```

Keep the key outside the web root and source control, restrict access to it, and back it up securely.
Losing or rotating this key without re-encrypting the stored values makes existing saved credentials
unreadable. Apply [binance_credentials.sql](./binance_credentials.sql) to an existing MySQL database;
the local SQLite database creates the credentials table automatically.

For the built-in loopback development server only, the application also reads the key from
`%LOCALAPPDATA%\ETHcryptohub\binance-credentials.key` if the environment variable is unavailable.
This fallback is not used for non-loopback or production requests.

The local SmartExit PHP bridge similarly reads its existing shared secret from
`%LOCALAPPDATA%\ETHcryptohub\smartexit-bridge.secret` when the loopback PHP server does not inherit
`SMARTEXIT_BRIDGE_SECRET`. Production must provide the secret through its protected server environment.

The Binance settings page currently stores credentials with AES-256-GCM and tests account access only.
It does not submit orders. Use a dedicated key with withdrawals disabled and IP restrictions; grant
futures read access only for the connection test.

## Local test user

Create one verified local-only test user from the repository root with:

```powershell
& "C:\path\to\php.exe" .\create-local-test-user.php
```

The script generates a random password, displays it once, refuses to overwrite an existing account,
and must never be run against production data.
