<?php
declare(strict_types=1);

ini_set('session.use_strict_mode', '1');
ini_set('session.use_only_cookies', '1');
ini_set('session.cookie_httponly', '1');

$requireProxy = filter_var(getenv('REQUIRE_VERCEL_PROXY') ?: '0', FILTER_VALIDATE_BOOL);
if ($requireProxy) {
    $proxySecret = (string) (getenv('PHP_PROXY_SECRET') ?: '');
    $proxyTimestamp = $_SERVER['HTTP_X_ETHCRYPTOHUB_PROXY_TIMESTAMP'] ?? '';
    $proxySignature = $_SERVER['HTTP_X_ETHCRYPTOHUB_PROXY_SIGNATURE'] ?? '';
    $requestPath = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    $validProxyRequest = strlen($proxySecret) >= 32
        && is_string($proxyTimestamp)
        && preg_match('/\A[0-9]{10}\z/', $proxyTimestamp) === 1
        && abs(time() - (int) $proxyTimestamp) <= 60
        && is_string($proxySignature)
        && preg_match('/\A[a-f0-9]{64}\z/i', $proxySignature) === 1
        && is_string($requestPath);
    if ($validProxyRequest) {
        $proxyMessage = $proxyTimestamp . "\n"
            . strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')) . "\n"
            . $requestPath;
        $validProxyRequest = hash_equals(
            hash_hmac('sha256', $proxyMessage, $proxySecret),
            strtolower($proxySignature)
        );
    }
    if (!$validProxyRequest) {
        http_response_code(403);
        exit('This application must be accessed through its configured proxy.');
    }
}

$requestHost = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
$requestHost = preg_replace('/:\d+$/', '', $requestHost);
$isLoopbackDevelopment = PHP_SAPI === 'cli-server'
    && in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true)
    && in_array($requestHost, ['localhost', '127.0.0.1', '[::1]', '::1'], true)
    && empty($_SERVER['HTTPS']);

session_name('ETHCRYPTOHUBSESSID');
session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/',
    'secure' => !$isLoopbackDevelopment,
    'httponly' => true,
    'samesite' => 'Strict',
]);

if (session_status() !== PHP_SESSION_ACTIVE && !session_start()) {
    throw new RuntimeException('Unable to start a secure session.');
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $postgresHost = trim((string) (getenv('SUPABASE_DB_HOST') ?: ''));
    if ($postgresHost !== '') {
        $postgresDatabase = trim((string) (getenv('SUPABASE_DB_NAME') ?: 'postgres'));
        $postgresUser = trim((string) (getenv('SUPABASE_DB_USER') ?: ''));
        $postgresPassword = (string) (getenv('SUPABASE_DB_PASSWORD') ?: '');
        $postgresPort = (int) (getenv('SUPABASE_DB_PORT') ?: 5432);
        $sslMode = trim((string) (getenv('SUPABASE_DB_SSLMODE') ?: 'require'));
        if ($postgresUser === '' || $postgresPassword === '' || $postgresPort < 1 || $postgresPort > 65535) {
            throw new RuntimeException('Supabase PostgreSQL connection settings are incomplete.');
        }
        if (!in_array($sslMode, ['require', 'verify-ca', 'verify-full'], true)) {
            throw new RuntimeException('SUPABASE_DB_SSLMODE must be require, verify-ca, or verify-full.');
        }
        if (!in_array('pgsql', PDO::getAvailableDrivers(), true)) {
            throw new RuntimeException('The PHP PDO PostgreSQL extension is required for Supabase.');
        }

        $dsn = sprintf(
            'pgsql:host=%s;port=%d;dbname=%s;sslmode=%s',
            $postgresHost,
            $postgresPort,
            $postgresDatabase,
            $sslMode
        );
        $pdo = new PDO($dsn, $postgresUser, $postgresPassword, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        return $pdo;
    }

    $host = getenv('DB_HOST') ?: '127.0.0.1';
    $database = getenv('DB_NAME') ?: '';
    $username = getenv('DB_USER') ?: '';
    $password = getenv('DB_PASS') ?: '';

    if ($database === '' || $username === '') {
        if (PHP_SAPI !== 'cli-server') {
            throw new RuntimeException('Database configuration is missing. Set DB_NAME and DB_USER.');
        }

        if (!in_array('sqlite', PDO::getAvailableDrivers(), true)) {
            throw new RuntimeException('Local SQLite support is not enabled. Restart PHP with -d extension=pdo_sqlite.');
        }

        $dataDirectory = getenv('LOCALAPPDATA') ?: sys_get_temp_dir();
        $dataDirectory .= DIRECTORY_SEPARATOR . 'ETHcryptohub';
        if (!is_dir($dataDirectory) && !mkdir($dataDirectory, 0700, true) && !is_dir($dataDirectory)) {
            throw new RuntimeException('Unable to create the local ETHcryptohub data directory.');
        }

        $sqlitePath = getenv('SQLITE_PATH') ?: $dataDirectory . DIRECTORY_SEPARATOR . 'ethcryptohub.sqlite';
        $pdo = new PDO('sqlite:' . $sqlitePath, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $pdo->exec('PRAGMA foreign_keys = ON');
        $pdo->exec('PRAGMA busy_timeout = 5000');
        initializeLocalSqliteDatabase($pdo);
        return $pdo;
    }

    $dsn = sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', $host, $database);
    $pdo = new PDO($dsn, $username, $password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);

    return $pdo;
}

function initializeLocalSqliteDatabase(PDO $pdo): void
{
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email VARCHAR(255) NOT NULL COLLATE NOCASE UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            full_name VARCHAR(150) NULL,
            country_code VARCHAR(8) NOT NULL DEFAULT \'+91\',
            phone_number VARCHAR(10) NULL,
            x_handle VARCHAR(100) NULL,
            is_x_verified INTEGER NOT NULL DEFAULT 0,
            email_verification_token VARCHAR(64) NULL UNIQUE,
            is_email_verified INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            role TEXT NOT NULL DEFAULT \'user\' CHECK (role IN (\'user\', \'admin\')),
            is_active INTEGER NOT NULL DEFAULT 1,
            last_login TIMESTAMP NULL DEFAULT NULL
        )'
    );
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS admin_login_attempts (
            ip_hash CHAR(64) NOT NULL PRIMARY KEY,
            attempts INTEGER NOT NULL DEFAULT 0,
            window_started_at DATETIME NOT NULL,
            locked_until DATETIME NULL DEFAULT NULL
        )'
    );
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS email_verification_requests (
            request_key CHAR(64) NOT NULL PRIMARY KEY,
            requested_at INTEGER NOT NULL
        )'
    );
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS email_verification_codes (
            user_id INTEGER NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            code_hash VARCHAR(255) NOT NULL,
            expires_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            locked_until INTEGER NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )'
    );
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS binance_api_credentials (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            api_key_ciphertext TEXT NOT NULL,
            api_secret_ciphertext TEXT NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )'
    );
}

function isLoopbackRequest(): bool
{
    $remoteAddress = $_SERVER['REMOTE_ADDR'] ?? '';
    $host = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
    $host = preg_replace('/:\d+$/', '', $host);

    return PHP_SAPI === 'cli-server'
        && in_array($remoteAddress, ['127.0.0.1', '::1'], true)
        && in_array($host, ['localhost', '127.0.0.1', '[::1]', '::1'], true)
        && empty($_SERVER['HTTPS']);
}

function curlCaBundlePath(): string|false|null
{
    $configuredPath = trim((string) (
        getenv('CURL_CA_BUNDLE')
        ?: ini_get('curl.cainfo')
        ?: ini_get('openssl.cafile')
        ?: ''
    ));
    if ($configuredPath !== '') {
        if (!is_file($configuredPath) || !is_readable($configuredPath)) {
            error_log('ETHcryptohub HTTPS request failed: configured CURL_CA_BUNDLE is not readable.');
            return false;
        }
        return $configuredPath;
    }

    $localDataDirectory = trim((string) (getenv('LOCALAPPDATA') ?: ''));
    if ($localDataDirectory !== '') {
        $localBundlePath = $localDataDirectory . DIRECTORY_SEPARATOR
            . 'ETHcryptohub' . DIRECTORY_SEPARATOR . 'cacert.pem';
        if (is_file($localBundlePath) && is_readable($localBundlePath)) {
            return $localBundlePath;
        }
    }

    return null;
}

function emailDeliveryConfigurationErrors(): array
{
    $errors = [];
    $apiKey = trim((string) (getenv('RESEND_API_KEY') ?: ''));
    $from = trim((string) (getenv('MAIL_FROM') ?: ''));

    if ($apiKey === '') {
        $errors[] = 'RESEND_API_KEY is not configured.';
    }
    if (filter_var($from, FILTER_VALIDATE_EMAIL) === false) {
        $errors[] = 'MAIL_FROM must be a verified sender email address.';
    }
    if (!function_exists('curl_init')) {
        $errors[] = 'The PHP cURL extension is unavailable.';
    } elseif (curlCaBundlePath() === false) {
        $errors[] = 'The configured HTTPS CA bundle is not readable.';
    }

    return $errors;
}

function sendEmailViaResend(string $email, string $subject, string $message, string $html): bool
{
    $apiKey = trim((string) (getenv('RESEND_API_KEY') ?: ''));
    $from = trim((string) (getenv('MAIL_FROM') ?: ''));
    if ($apiKey === ''
        || filter_var($from, FILTER_VALIDATE_EMAIL) === false
        || !function_exists('curl_init')) {
        error_log('ETHcryptohub email not sent: Resend email configuration is incomplete.');
        return false;
    }

    $payload = json_encode([
        'from' => $from,
        'to' => [$email],
        'subject' => $subject,
        'text' => $message,
        'html' => $html,
    ], JSON_THROW_ON_ERROR);
    $handle = curl_init('https://api.resend.com/emails');
    if ($handle === false) {
        error_log('ETHcryptohub email not sent: unable to initialize the Resend request.');
        return false;
    }

    $curlOptions = [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $payload,
        CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . $apiKey,
            'Content-Type: application/json',
            'Accept: application/json',
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
    ];
    $caBundlePath = curlCaBundlePath();
    if ($caBundlePath === false) {
        curl_close($handle);
        return false;
    }
    if (is_string($caBundlePath)) {
        $curlOptions[CURLOPT_CAINFO] = $caBundlePath;
    }
    curl_setopt_array($handle, $curlOptions);

    $response = curl_exec($handle);
    $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    $errorNumber = curl_errno($handle);
    curl_close($handle);

    if ($response === false || $errorNumber !== 0 || $status < 200 || $status >= 300) {
        error_log('ETHcryptohub email delivery failed (Resend HTTP status ' . $status
            . ', cURL error ' . $errorNumber . ').');
        return false;
    }

    return true;
}

function issueEmailVerificationCode(PDO $pdo, int $userId, string $email): string|bool
{
    $apiKey = trim((string) (getenv('RESEND_API_KEY') ?: ''));
    $select = $pdo->prepare(
        'SELECT attempts, locked_until FROM email_verification_codes WHERE user_id = :user_id'
    );
    $select->execute([':user_id' => $userId]);
    $existing = $select->fetch();
    $attempts = is_array($existing) ? (int) $existing['attempts'] : 0;
    $lockedUntil = is_array($existing) && $existing['locked_until'] !== null
        ? (int) $existing['locked_until']
        : null;

    if ($apiKey === '' && isLoopbackRequest()) {
        $localDelivery = true;
    } elseif (emailDeliveryConfigurationErrors() !== []) {
        error_log('ETHcryptohub verification code not sent: configure Resend and a verified sender.');
        return false;
    } else {
        $localDelivery = false;
    }

    if ($lockedUntil !== null && $lockedUntil > time()) {
        return false;
    }

    if ($lockedUntil !== null && $lockedUntil <= time()) {
        $attempts = 0;
        $lockedUntil = null;
    }

    $code = sprintf('%06d', random_int(0, 999999));
    if (!$localDelivery) {
        $subject = 'Your ETHcryptohub email verification code';
        $message = "Your ETHcryptohub verification code is {$code}.\n\n"
            . "This code expires in 10 minutes and can be used once. "
            . "If you did not create an account, you can ignore this email.\n";
        $html = '<p>Your ETHcryptohub verification code is:</p>'
            . '<p style="font-size:28px;font-weight:bold;letter-spacing:8px">'
            . e($code) . '</p><p>This code expires in 10 minutes and can be used once.</p>'
            . '<p>If you did not create an account, you can ignore this email.</p>';
        if (!sendEmailViaResend($email, $subject, $message, $html)) {
            return false;
        }
    }

    $codeHash = password_hash($code, PASSWORD_DEFAULT);
    if ($codeHash === false) {
        throw new RuntimeException('Email verification code hashing failed.');
    }

    $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'sqlite' || $driver === 'pgsql') {
        $conflictClause = $driver === 'sqlite'
            ? 'ON CONFLICT(user_id) DO UPDATE SET'
            : 'ON CONFLICT (user_id) DO UPDATE SET';
        $store = $pdo->prepare(
            'INSERT INTO email_verification_codes
                (user_id, code_hash, expires_at, attempts, locked_until, created_at)
             VALUES (:user_id, :code_hash, :expires_at, :attempts, :locked_until, CURRENT_TIMESTAMP)
             ' . $conflictClause . '
                code_hash = excluded.code_hash,
                expires_at = excluded.expires_at,
                attempts = excluded.attempts,
                locked_until = excluded.locked_until,
                created_at = CURRENT_TIMESTAMP'
        );
    } else {
        $store = $pdo->prepare(
            'INSERT INTO email_verification_codes
                (user_id, code_hash, expires_at, attempts, locked_until)
             VALUES (:user_id, :code_hash, :expires_at, :attempts, :locked_until)
             ON DUPLICATE KEY UPDATE
                code_hash = VALUES(code_hash),
                expires_at = VALUES(expires_at),
                attempts = VALUES(attempts),
                locked_until = VALUES(locked_until),
                created_at = CURRENT_TIMESTAMP'
        );
    }
    $store->execute([
        ':user_id' => $userId,
        ':code_hash' => $codeHash,
        ':expires_at' => time() + 600,
        ':attempts' => $attempts,
        ':locked_until' => $lockedUntil,
    ]);

    return $localDelivery ? $code : true;
}

function verifyEmailCode(PDO $pdo, string $email, string $code): bool
{
    $pdo->beginTransaction();
    try {
        $userQuery = $pdo->prepare(
            'SELECT id, is_email_verified, is_active FROM users WHERE email = :email LIMIT 1'
        );
        $userQuery->execute([':email' => $email]);
        $user = $userQuery->fetch();
        if (!is_array($user)
            || (int) $user['is_email_verified'] === 1
            || (int) $user['is_active'] !== 1) {
            $pdo->commit();
            return false;
        }

        $forUpdate = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite' ? '' : ' FOR UPDATE';
        $codeQuery = $pdo->prepare(
            'SELECT code_hash, expires_at, attempts, locked_until
             FROM email_verification_codes WHERE user_id = :user_id' . $forUpdate
        );
        $codeQuery->execute([':user_id' => $user['id']]);
        $storedCode = $codeQuery->fetch();
        if (!is_array($storedCode)
            || (int) $storedCode['expires_at'] < time()
            || ($storedCode['locked_until'] !== null && (int) $storedCode['locked_until'] > time())) {
            $pdo->commit();
            return false;
        }

        if (password_verify($code, (string) $storedCode['code_hash'])) {
            $updateUser = $pdo->prepare(
                'UPDATE users
                 SET is_email_verified = 1, email_verification_token = NULL
                 WHERE id = :id AND is_email_verified = 0 AND is_active = 1'
            );
            $updateUser->execute([':id' => $user['id']]);
            if ($updateUser->rowCount() !== 1) {
                $pdo->rollBack();
                return false;
            }

            $deleteCode = $pdo->prepare('DELETE FROM email_verification_codes WHERE user_id = :user_id');
            $deleteCode->execute([':user_id' => $user['id']]);
            $pdo->commit();
            return true;
        }

        $attempts = (int) $storedCode['attempts'] + 1;
        $lockedUntil = $attempts >= 5 ? time() + 900 : $storedCode['locked_until'];
        $updateCode = $pdo->prepare(
            'UPDATE email_verification_codes
             SET attempts = :attempts, locked_until = :locked_until
             WHERE user_id = :user_id'
        );
        $updateCode->execute([
            ':attempts' => $attempts,
            ':locked_until' => $lockedUntil,
            ':user_id' => $user['id'],
        ]);
        $pdo->commit();
        return false;
    } catch (Throwable $exception) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $exception;
    }
}

function binanceCredentialsEncryptionKey(): string
{
    $configuredKey = trim((string) (getenv('BINANCE_CREDENTIALS_KEY') ?: ''));
    if ($configuredKey === '' && isLoopbackRequest()) {
        $localDataDirectory = trim((string) (getenv('LOCALAPPDATA') ?: ''));
        if ($localDataDirectory !== '') {
            $localKeyPath = $localDataDirectory . DIRECTORY_SEPARATOR
                . 'ETHcryptohub' . DIRECTORY_SEPARATOR . 'binance-credentials.key';
            if (is_file($localKeyPath) && is_readable($localKeyPath)) {
                $localKey = file_get_contents($localKeyPath);
                $configuredKey = is_string($localKey) ? trim($localKey) : '';
            }
        }
    }

    if (preg_match('/\A[a-fA-F0-9]{64}\z/', $configuredKey) !== 1) {
        throw new RuntimeException('BINANCE_CREDENTIALS_KEY must be configured as 64 hexadecimal characters.');
    }

    $key = hex2bin($configuredKey);
    if ($key === false || strlen($key) !== 32) {
        throw new RuntimeException('BINANCE_CREDENTIALS_KEY is invalid.');
    }

    return $key;
}

function encryptBinanceCredential(string $plaintext): string
{
    if (!function_exists('openssl_encrypt')) {
        throw new RuntimeException('The PHP OpenSSL extension is required to store Binance credentials.');
    }

    $nonce = random_bytes(12);
    $tag = '';
    $ciphertext = openssl_encrypt(
        $plaintext,
        'aes-256-gcm',
        binanceCredentialsEncryptionKey(),
        OPENSSL_RAW_DATA,
        $nonce,
        $tag
    );
    if ($ciphertext === false || strlen($tag) !== 16) {
        throw new RuntimeException('Unable to encrypt Binance credentials.');
    }

    return base64_encode($nonce . $tag . $ciphertext);
}

function decryptBinanceCredential(string $encodedCiphertext): string
{
    if (!function_exists('openssl_decrypt')) {
        throw new RuntimeException('The PHP OpenSSL extension is required to read Binance credentials.');
    }

    $payload = base64_decode($encodedCiphertext, true);
    if ($payload === false || strlen($payload) < 29) {
        throw new RuntimeException('Stored Binance credentials are invalid.');
    }

    $nonce = substr($payload, 0, 12);
    $tag = substr($payload, 12, 16);
    $ciphertext = substr($payload, 28);
    $plaintext = openssl_decrypt(
        $ciphertext,
        'aes-256-gcm',
        binanceCredentialsEncryptionKey(),
        OPENSSL_RAW_DATA,
        $nonce,
        $tag
    );
    if ($plaintext === false) {
        throw new RuntimeException('Unable to decrypt Binance credentials. Check BINANCE_CREDENTIALS_KEY.');
    }

    return $plaintext;
}

function allowVerificationResend(PDO $pdo, string $email, string $ipAddress): bool
{
    $key = hash('sha256', strtolower(trim($email)) . "\0" . $ipAddress);
    $isSqlite = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
    $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    $ignore = match ($driver) {
        'sqlite' => 'INSERT OR IGNORE',
        'pgsql' => 'INSERT',
        default => 'INSERT IGNORE',
    };
    $initialTime = match ($driver) {
        'sqlite' => 'CAST(strftime(\'%s\', \'now\') AS INTEGER)',
        'pgsql' => 'EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::BIGINT',
        default => 'UNIX_TIMESTAMP()',
    };

    $pdo->beginTransaction();
    try {
        $conflictClause = $driver === 'pgsql' ? ' ON CONFLICT (request_key) DO NOTHING' : '';
        $insert = $pdo->prepare(
            $ignore . ' INTO email_verification_requests (request_key, requested_at)
             VALUES (:request_key, ' . $initialTime . ')' . $conflictClause
        );
        $insert->execute([':request_key' => $key]);
        if ($insert->rowCount() === 1) {
            $pdo->commit();
            return true;
        }

        $lock = $isSqlite ? '' : ' FOR UPDATE';
        $select = $pdo->prepare(
            'SELECT requested_at FROM email_verification_requests WHERE request_key = :request_key' . $lock
        );
        $select->execute([':request_key' => $key]);
        $requestedAt = $select->fetchColumn();
        $now = time();

        if ($requestedAt !== false && $now - (int) $requestedAt < 60) {
            $pdo->commit();
            return false;
        }

        $update = $pdo->prepare(
            'UPDATE email_verification_requests SET requested_at = :requested_at WHERE request_key = :request_key'
        );
        $update->execute([':requested_at' => $now, ':request_key' => $key]);
        $pdo->commit();
        return true;
    } catch (Throwable $exception) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $exception;
    }
}

function csrf_token(): string
{
    if (!isset($_SESSION['csrf_token']) || !is_string($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }

    return $_SESSION['csrf_token'];
}

function verify_csrf_token(?string $submittedToken): bool
{
    return isset($_SESSION['csrf_token'])
        && is_string($_SESSION['csrf_token'])
        && is_string($submittedToken)
        && hash_equals($_SESSION['csrf_token'], $submittedToken);
}

function e(string|int|null $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}
