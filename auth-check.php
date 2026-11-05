<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

function clear_authenticated_session(): void
{
    $_SESSION = [];
    $cookie = session_get_cookie_params();
    setcookie(session_name(), '', [
        'expires' => time() - 42000,
        'path' => $cookie['path'],
        'domain' => $cookie['domain'],
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    session_destroy();
}

function loadAuthenticatedUser(): ?array
{
    if (!isset($_SESSION['user_id']) || !is_int($_SESSION['user_id']) || $_SESSION['user_id'] < 1) {
        return null;
    }

    $statement = db()->prepare(
        'SELECT id, email, full_name, country_code, phone_number, x_handle,
                is_x_verified, is_email_verified, is_active, role, created_at, last_login
         FROM users WHERE id = :id LIMIT 1'
    );
    $statement->execute([':id' => $_SESSION['user_id']]);
    $user = $statement->fetch();

    return $user ?: null;
}

function authenticationFailure(int $status, string $message, bool $jsonResponse): void
{
    http_response_code($status);

    if ($jsonResponse) {
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode(['ok' => false, 'error' => $message], JSON_THROW_ON_ERROR);
        exit;
    }

    if ($status === 503) {
        exit($message);
    }

    header('Location: login.php', true, 303);
    exit;
}

function isAuthenticatedSessionExpired(bool $touchActivity): bool
{
    $now = time();
    $lastActivity = $_SESSION['last_activity'] ?? null;

    if (is_int($lastActivity) && $now - $lastActivity >= 900) {
        return true;
    }

    if ($touchActivity) {
        $_SESSION['last_activity'] = $now;
    }
    return false;
}

function requireUser(bool $jsonResponse = false): array
{
    if (!isset($_SESSION['user_id']) || !is_int($_SESSION['user_id']) || $_SESSION['user_id'] < 1) {
        authenticationFailure(401, 'Sign in is required.', $jsonResponse);
    }
    $recentApiInteraction = $jsonResponse && ($_SERVER['HTTP_X_USER_ACTIVE'] ?? '') === '1';
    if (isAuthenticatedSessionExpired(!$jsonResponse || $recentApiInteraction)) {
        clear_authenticated_session();
        authenticationFailure(401, 'Your session expired after 15 minutes of inactivity. Sign in again.', $jsonResponse);
    }

    try {
        $user = loadAuthenticatedUser();
    } catch (PDOException | RuntimeException $exception) {
        error_log('ETHcryptohub authentication database error: ' . $exception->getMessage());
        authenticationFailure(503, 'Authentication is temporarily unavailable. Please try again later.', $jsonResponse);
    }

    if (!$user || (int) $user['is_email_verified'] !== 1 || (int) $user['is_active'] !== 1) {
        clear_authenticated_session();
        authenticationFailure(401, 'This account cannot access the requested resource.', $jsonResponse);
    }

    return $user;
}

function requireAdmin(): array
{
    if (!isset($_SESSION['user_id']) || !is_int($_SESSION['user_id']) || $_SESSION['user_id'] < 1) {
        header('Location: login.php', true, 303);
        exit;
    }
    if (isAuthenticatedSessionExpired(true)) {
        clear_authenticated_session();
        header('Location: login.php', true, 303);
        exit;
    }

    try {
        $user = loadAuthenticatedUser();
    } catch (PDOException | RuntimeException $exception) {
        error_log('ETHcryptohub admin authorization database error: ' . $exception->getMessage());
        http_response_code(503);
        exit('Authorization is temporarily unavailable. Please try again later.');
    }

    if (!$user || (int) $user['is_email_verified'] !== 1 || (int) $user['is_active'] !== 1 || $user['role'] !== 'admin') {
        if (!$user || (int) ($user['is_active'] ?? 0) !== 1 || (int) ($user['is_email_verified'] ?? 0) !== 1) {
            clear_authenticated_session();
            header('Location: login.php', true, 303);
            exit;
        }

        http_response_code(403);
        ?>
        <!doctype html>
        <html lang="en" class="dark">
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Access denied | ETHcryptohub</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <script>
                window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
            </script>
            <script defer src="/_vercel/insights/script.js"></script>
        </head>
        <body class="grid min-h-screen place-items-center bg-[#07090e] px-4 text-slate-100">
            <main class="max-w-md rounded-2xl border border-slate-800 bg-[#0f1420] p-8 text-center">
                <p class="text-xs uppercase tracking-[.2em] text-rose-400">403 · restricted area</p>
                <h1 class="mt-4 text-2xl font-semibold">Admin access required</h1>
                <p class="mt-3 text-sm text-slate-400">Your account is not authorized to access the admin command center.</p>
                <a href="../dashboard.php" class="mt-6 inline-flex rounded-full bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-slate-950">Return to dashboard</a>
            </main>
        </body>
        </html>
        <?php
        exit;
    }

    return $user;
}
