<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

if (strtolower((string) (getenv('APP_ENV') ?: 'development')) === 'production') {
    fwrite(STDERR, "Refusing to create a test account when APP_ENV=production.\n");
    exit(1);
}

$dataDirectory = getenv('LOCALAPPDATA') ?: sys_get_temp_dir();
$dataDirectory .= DIRECTORY_SEPARATOR . 'ETHcryptohub';
$databasePath = getenv('SQLITE_PATH') ?: $dataDirectory . DIRECTORY_SEPARATOR . 'ethcryptohub.sqlite';
if (!is_file($databasePath)) {
    fwrite(STDERR, "Local ETHcryptohub SQLite database not found: " . $databasePath . "\n");
    exit(1);
}

$email = 'test.user@ethcryptohub.local';
$password = bin2hex(random_bytes(24));
$pdo = new PDO('sqlite:' . $databasePath, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
]);

$exists = $pdo->prepare('SELECT id FROM users WHERE email = :email');
$exists->execute([':email' => $email]);
if ($exists->fetchColumn() !== false) {
    fwrite(STDERR, "The local test account already exists; refusing to replace its password.\n");
    exit(1);
}

$insert = $pdo->prepare(
    'INSERT INTO users (
        email, password_hash, full_name, country_code, is_email_verified,
        email_verification_token, role, is_active
    ) VALUES (
        :email, :password_hash, :full_name, :country_code, 1, NULL, :role, 1
    )'
);
$insert->execute([
    ':email' => $email,
    ':password_hash' => password_hash($password, PASSWORD_BCRYPT),
    ':full_name' => 'Local Test User',
    ':country_code' => '+1',
    ':role' => 'user',
]);

fwrite(STDOUT, "LOCAL DEVELOPMENT TEST ACCOUNT (verified; do not use in production)\n");
fwrite(STDOUT, "Email: " . $email . "\n");
fwrite(STDOUT, "Password (shown once): " . $password . "\n");
