<?php
declare(strict_types=1);

require_once __DIR__ . '/auth-check.php';
$user = requireUser();
$pdo = db();
$notice = '';
$noticeType = 'info';
$configured = false;
$updatedAt = null;

function testBinanceFuturesCredentials(string $apiKey, string $apiSecret): bool
{
    if (!function_exists('curl_init')) {
        throw new RuntimeException('The PHP cURL extension is required to test the Binance connection.');
    }

    $query = http_build_query([
        'recvWindow' => 5000,
        'timestamp' => (int) floor(microtime(true) * 1000),
    ], '', '&', PHP_QUERY_RFC3986);
    $signature = hash_hmac('sha256', $query, $apiSecret);
    $handle = curl_init('https://fapi.binance.com/fapi/v3/account?' . $query . '&signature=' . $signature);
    if ($handle === false) {
        throw new RuntimeException('Unable to initialize the Binance connection test.');
    }

    $curlOptions = [
        CURLOPT_HTTPGET => true,
        CURLOPT_HTTPHEADER => [
            'X-MBX-APIKEY: ' . $apiKey,
            'Accept: application/json',
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 12,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
    ];
    $caBundlePath = curlCaBundlePath();
    if ($caBundlePath === false) {
        curl_close($handle);
        throw new RuntimeException('The configured HTTPS certificate bundle is unavailable.');
    }
    if (is_string($caBundlePath)) {
        $curlOptions[CURLOPT_CAINFO] = $caBundlePath;
    }
    curl_setopt_array($handle, $curlOptions);

    $response = curl_exec($handle);
    $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    $errorNumber = curl_errno($handle);
    curl_close($handle);

    if ($response === false || $errorNumber !== 0) {
        error_log('ETHcryptohub Binance connection test failed (cURL error ' . $errorNumber . ').');
        throw new RuntimeException(
            'Binance could not be reached (cURL error ' . $errorNumber . '). Check the server connection and try again.'
        );
    }

    return $status === 200;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    if (!verify_csrf_token($_POST['csrf_token'] ?? null)) {
        http_response_code(403);
        exit('Invalid form token.');
    }

    if (empty($_SERVER['HTTPS']) && !isLoopbackRequest()) {
        http_response_code(400);
        exit('Use HTTPS to manage exchange credentials.');
    }

    $action = $_POST['action'] ?? '';
    if (!is_string($action)) {
        http_response_code(400);
        exit('Invalid action.');
    }

    if ($action === 'save') {
        $apiKeyInput = $_POST['api_key'] ?? null;
        $apiSecretInput = $_POST['api_secret'] ?? null;
        $apiKey = is_string($apiKeyInput) ? trim($apiKeyInput) : '';
        $apiSecret = is_string($apiSecretInput) ? trim($apiSecretInput) : '';
        if (preg_match('/\A[A-Za-z0-9]{20,128}\z/', $apiKey) !== 1
            || preg_match('/\A[A-Za-z0-9]{20,128}\z/', $apiSecret) !== 1) {
            http_response_code(422);
            $notice = 'Enter a valid Binance API key and secret. Neither value can be left blank.';
            $noticeType = 'error';
        } else {
            try {
                $encryptedKey = encryptBinanceCredential($apiKey);
                $encryptedSecret = encryptBinanceCredential($apiSecret);
                $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
                if ($driver === 'sqlite' || $driver === 'pgsql') {
                    $conflictClause = $driver === 'sqlite'
                        ? 'ON CONFLICT(user_id) DO UPDATE SET'
                        : 'ON CONFLICT (user_id) DO UPDATE SET';
                    $statement = $pdo->prepare(
                        'INSERT INTO binance_api_credentials
                            (user_id, api_key_ciphertext, api_secret_ciphertext, updated_at)
                         VALUES (:user_id, :api_key, :api_secret, CURRENT_TIMESTAMP)
                         ' . $conflictClause . '
                            api_key_ciphertext = excluded.api_key_ciphertext,
                            api_secret_ciphertext = excluded.api_secret_ciphertext,
                            updated_at = CURRENT_TIMESTAMP'
                    );
                } else {
                    $statement = $pdo->prepare(
                        'INSERT INTO binance_api_credentials
                            (user_id, api_key_ciphertext, api_secret_ciphertext)
                         VALUES (:user_id, :api_key, :api_secret)
                         ON DUPLICATE KEY UPDATE
                            api_key_ciphertext = VALUES(api_key_ciphertext),
                            api_secret_ciphertext = VALUES(api_secret_ciphertext),
                            updated_at = CURRENT_TIMESTAMP'
                    );
                }
                $statement->execute([
                    ':user_id' => $user['id'],
                    ':api_key' => $encryptedKey,
                    ':api_secret' => $encryptedSecret,
                ]);
                header('Location: binance-settings.php?saved=1', true, 303);
                exit;
            } catch (Throwable $exception) {
                error_log('ETHcryptohub could not save Binance credentials: ' . $exception->getMessage());
                $notice = 'Could not securely save the credentials. Check server encryption-key configuration.';
                $noticeType = 'error';
            }
        }
    } elseif ($action === 'remove') {
        $statement = $pdo->prepare('DELETE FROM binance_api_credentials WHERE user_id = :user_id');
        $statement->execute([':user_id' => $user['id']]);
        header('Location: binance-settings.php?removed=1', true, 303);
        exit;
    } elseif ($action === 'test') {
        $statement = $pdo->prepare(
            'SELECT api_key_ciphertext, api_secret_ciphertext
             FROM binance_api_credentials WHERE user_id = :user_id'
        );
        $statement->execute([':user_id' => $user['id']]);
        $credentials = $statement->fetch();
        if (!is_array($credentials)) {
            $notice = 'Save your Binance credentials before testing the connection.';
            $noticeType = 'error';
        } else {
            try {
                $apiKey = decryptBinanceCredential((string) $credentials['api_key_ciphertext']);
                $apiSecret = decryptBinanceCredential((string) $credentials['api_secret_ciphertext']);
                $success = testBinanceFuturesCredentials($apiKey, $apiSecret);
                $notice = $success
                    ? 'Binance USDⓈ-M Futures account connection verified. No orders were placed.'
                    : 'Binance rejected the connection. Check the key, futures read permission, and server clock.';
                $noticeType = $success ? 'success' : 'error';
            } catch (RuntimeException $exception) {
                error_log('ETHcryptohub Binance connection test failed: ' . $exception->getMessage());
                $notice = $exception->getMessage();
                $noticeType = 'error';
            } catch (Throwable $exception) {
                error_log('ETHcryptohub Binance connection test error: ' . $exception->getMessage());
                $notice = 'The Binance connection test could not be completed. Check server configuration and try again.';
                $noticeType = 'error';
            }
        }
    } else {
        http_response_code(400);
        exit('Unsupported action.');
    }
}

$statement = $pdo->prepare(
    'SELECT updated_at FROM binance_api_credentials WHERE user_id = :user_id'
);
$statement->execute([':user_id' => $user['id']]);
$credentialRow = $statement->fetch();
$configured = is_array($credentialRow);
$updatedAt = $configured ? (string) $credentialRow['updated_at'] : null;

if (isset($_GET['saved'])) {
    $notice = 'Encrypted Binance credentials saved. Test the connection before use.';
    $noticeType = 'success';
} elseif (isset($_GET['removed'])) {
    $notice = 'Binance credentials removed.';
    $noticeType = 'success';
}
?>
<!doctype html>
<html lang="en" class="dark">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#07090e">
    <title>Binance API settings | ETHcryptohub</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    </script>
    <script defer src="/_vercel/insights/script.js"></script>
</head>
<body class="min-h-screen bg-[#07090e] text-slate-100">
<main class="mx-auto max-w-3xl px-5 py-10 sm:px-8">
    <header class="mb-10 flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
        <a href="dashboard.php" class="font-semibold tracking-[.18em] text-cyan-300">ETHCRYPTOHUB</a>
        <nav class="flex gap-4 text-sm text-slate-400">
            <a class="hover:text-white" href="settings.php">Profile settings</a>
            <a class="hover:text-white" href="dashboard.php">Dashboard</a>
        </nav>
    </header>

    <p class="mb-3 text-xs font-semibold uppercase tracking-[.2em] text-cyan-300">Exchange connection</p>
    <h1 class="text-3xl font-semibold">Binance API settings</h1>
    <p class="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
        Credentials are encrypted on this server and scoped to your account. This page can verify
        USDⓈ-M Futures account access; it does not place, cancel, or modify orders.
    </p>

    <?php if ($notice !== ''): ?>
        <?php
        $noticeClasses = $noticeType === 'success'
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
            : ($noticeType === 'error'
                ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                : 'border-sky-500/30 bg-sky-500/10 text-sky-200');
        ?>
        <div class="mt-6 rounded-xl border px-4 py-3 text-sm <?= e($noticeClasses) ?>" role="status">
            <?= e($notice) ?>
        </div>
    <?php endif; ?>

    <section class="mt-8 rounded-2xl border border-white/10 bg-[#0f1420] p-5 sm:p-7">
        <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="font-medium">Connection status</h2>
            <?php if ($configured): ?>
                <span class="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-300">Credentials saved</span>
            <?php else: ?>
                <span class="rounded-full border border-slate-500/30 bg-slate-500/10 px-3 py-1 text-xs text-slate-300">Not configured</span>
            <?php endif; ?>
        </div>
        <?php if ($updatedAt !== null): ?>
            <p class="mt-2 text-xs text-slate-500">Last updated: <?= e($updatedAt) ?></p>
        <?php endif; ?>

        <form method="post" action="binance-settings.php" class="mt-6 space-y-5" autocomplete="off">
            <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
            <input type="hidden" name="action" value="save">
            <label class="block">
                <span class="mb-2 block text-sm text-slate-300">Binance API key</span>
                <input name="api_key" type="password" required minlength="20" maxlength="128"
                       autocomplete="new-password" spellcheck="false"
                       class="w-full rounded-xl border border-slate-700 bg-[#07090e] px-4 py-3 text-sm outline-none focus:border-cyan-400"
                       placeholder="<?= $configured ? 'Enter a new key to replace the saved key' : 'Paste API key' ?>">
            </label>
            <label class="block">
                <span class="mb-2 block text-sm text-slate-300">Binance API secret</span>
                <input name="api_secret" type="password" required minlength="20" maxlength="128"
                       autocomplete="new-password" spellcheck="false"
                       class="w-full rounded-xl border border-slate-700 bg-[#07090e] px-4 py-3 text-sm outline-none focus:border-cyan-400"
                       placeholder="<?= $configured ? 'Enter a new secret to replace the saved secret' : 'Paste API secret' ?>">
            </label>
            <button type="submit" class="rounded-full bg-cyan-300 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-cyan-200">
                Save encrypted credentials
            </button>
        </form>

        <?php if ($configured): ?>
            <div class="mt-5 flex flex-wrap gap-3 border-t border-white/10 pt-5">
                <form method="post" action="binance-settings.php">
                    <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
                    <input type="hidden" name="action" value="test">
                    <button type="submit" class="rounded-full border border-white/15 px-4 py-2 text-sm text-slate-200 hover:border-cyan-300/50">
                        Test Futures account connection
                    </button>
                </form>
                <form method="post" action="binance-settings.php"
                      onsubmit="return confirm('Remove the saved Binance API credentials?')">
                    <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
                    <input type="hidden" name="action" value="remove">
                    <button type="submit" class="rounded-full border border-rose-400/25 px-4 py-2 text-sm text-rose-300 hover:bg-rose-400/10">
                        Remove credentials
                    </button>
                </form>
            </div>
        <?php endif; ?>
    </section>

    <aside class="mt-6 rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm leading-6 text-amber-100/80">
        Use a dedicated Binance key with withdrawals disabled and IP restrictions enabled. Only grant
        futures read access for this connection test. Manual live USDⓈ-M Futures orders are not enabled
        by this settings page and require a separately reviewed, explicitly confirmed implementation.
    </aside>
</main>
</body>
</html>
