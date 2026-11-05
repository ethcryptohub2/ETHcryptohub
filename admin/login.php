<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';

$errors = [];
$email = '';
$locked = false;
$ipAddress = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$ipHash = hash('sha256', $ipAddress);

function isAdminLoginLocked(PDO $pdo, string $ipHash): bool
{
    $statement = $pdo->prepare('SELECT locked_until FROM admin_login_attempts WHERE ip_hash = :ip_hash LIMIT 1');
    $statement->execute([':ip_hash' => $ipHash]);
    $lockedUntil = $statement->fetchColumn();

    return is_string($lockedUntil)
        && new DateTimeImmutable($lockedUntil, new DateTimeZone('UTC')) > new DateTimeImmutable('now', new DateTimeZone('UTC'));
}

function recordAdminLoginFailure(PDO $pdo, string $ipHash): void
{
    $pdo->beginTransaction();
    try {
        $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
        $sqlite = $driver === 'sqlite';
        $ignore = match ($driver) {
            'sqlite' => 'INSERT OR IGNORE',
            'pgsql' => 'INSERT',
            default => 'INSERT IGNORE',
        };
        $currentTimestamp = $driver === 'mysql' ? 'UTC_TIMESTAMP()' : 'CURRENT_TIMESTAMP';
        $conflictClause = $driver === 'pgsql' ? ' ON CONFLICT (ip_hash) DO NOTHING' : '';
        $insert = $pdo->prepare(
            $ignore . ' INTO admin_login_attempts (ip_hash, attempts, window_started_at)
             VALUES (:ip_hash, 0, ' . $currentTimestamp . ')' . $conflictClause
        );
        $insert->execute([':ip_hash' => $ipHash]);

        $forUpdate = $sqlite ? '' : ' FOR UPDATE';
        $select = $pdo->prepare('SELECT attempts, window_started_at FROM admin_login_attempts WHERE ip_hash = :ip_hash' . $forUpdate);
        $select->execute([':ip_hash' => $ipHash]);
        $attempt = $select->fetch();
        if (!$attempt) {
            throw new RuntimeException('Unable to record admin login attempt.');
        }

        $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $windowStarted = new DateTimeImmutable($attempt['window_started_at'], new DateTimeZone('UTC'));
        $attempts = $now->getTimestamp() - $windowStarted->getTimestamp() >= 900
            ? 1
            : (int) $attempt['attempts'] + 1;
        $windowStartValue = $attempts === 1 ? $now->format('Y-m-d H:i:s') : $attempt['window_started_at'];
        $lockUntil = $attempts >= 5 ? $now->modify('+15 minutes')->format('Y-m-d H:i:s') : null;

        $update = $pdo->prepare(
            'UPDATE admin_login_attempts
             SET attempts = :attempts, window_started_at = :window_started_at, locked_until = :locked_until
             WHERE ip_hash = :ip_hash'
        );
        $update->execute([
            ':attempts' => $attempts,
            ':window_started_at' => $windowStartValue,
            ':locked_until' => $lockUntil,
            ':ip_hash' => $ipHash,
        ]);
        $pdo->commit();
    } catch (Throwable $exception) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $exception;
    }
}

if (isset($_SESSION['user_id']) && is_int($_SESSION['user_id'])) {
    try {
        $statement = db()->prepare(
            'SELECT role, is_active, is_email_verified FROM users WHERE id = :id LIMIT 1'
        );
        $statement->execute([':id' => $_SESSION['user_id']]);
        $currentUser = $statement->fetch();
        if ($currentUser && $currentUser['role'] === 'admin'
            && (int) $currentUser['is_active'] === 1
            && (int) $currentUser['is_email_verified'] === 1) {
            header('Location: dashboard.php', true, 303);
            exit;
        }
    } catch (PDOException | RuntimeException $exception) {
        error_log('ETHcryptohub admin login session lookup error: ' . $exception->getMessage());
        http_response_code(503);
        exit('Admin sign in is temporarily unavailable. Please try again later.');
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $submittedCsrfToken = $_POST['csrf_token'] ?? null;
    if (!verify_csrf_token(is_string($submittedCsrfToken) ? $submittedCsrfToken : null)) {
        http_response_code(403);
        $errors[] = 'Your form session expired. Refresh the page and try again.';
    } else {
        $submittedEmail = $_POST['email'] ?? null;
        $submittedPassword = $_POST['password'] ?? null;
        $email = is_string($submittedEmail) ? trim($submittedEmail) : '';
        $password = is_string($submittedPassword) ? $submittedPassword : '';

        try {
            $pdo = db();
            $locked = isAdminLoginLocked($pdo, $ipHash);
            if ($locked) {
                $errors[] = 'Sign in is temporarily locked. Try again in 15 minutes.';
            } elseif (filter_var($email, FILTER_VALIDATE_EMAIL) === false || strlen($email) > 255 || $password === '' || strlen($password) > 72) {
                recordAdminLoginFailure($pdo, $ipHash);
                $errors[] = 'Email or password is incorrect.';
            } else {
                $statement = $pdo->prepare(
                    'SELECT id, password_hash, role, is_active, is_email_verified
                     FROM users WHERE email = :email LIMIT 1'
                );
                $statement->execute([':email' => $email]);
                $user = $statement->fetch();

                if (!$user || !password_verify($password, $user['password_hash'])
                    || $user['role'] !== 'admin'
                    || (int) $user['is_active'] !== 1
                    || (int) $user['is_email_verified'] !== 1) {
                    recordAdminLoginFailure($pdo, $ipHash);
                    $errors[] = 'Email or password is incorrect.';
                } else {
                    $update = $pdo->prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = :id');
                    $update->execute([':id' => $user['id']]);
                    $clearAttempts = $pdo->prepare('DELETE FROM admin_login_attempts WHERE ip_hash = :ip_hash');
                    $clearAttempts->execute([':ip_hash' => $ipHash]);

                    session_regenerate_id(true);
                    $_SESSION['user_id'] = (int) $user['id'];
                    $_SESSION['user_role'] = 'admin';
                    $_SESSION['last_activity'] = time();
                    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
                    header('Location: dashboard.php', true, 303);
                    exit;
                }
            }
        } catch (PDOException | RuntimeException $exception) {
            error_log('ETHcryptohub admin login database error: ' . $exception->getMessage());
            http_response_code(503);
            $errors[] = 'Admin sign in is temporarily unavailable. Please try again later.';
        }
    }
}
?>
<!doctype html>
<html lang="en" class="dark">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#07090e">
    <title>Admin gateway | ETHcryptohub</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>body{font-family:'Space Grotesk',sans-serif;background:#07090e}.mono{font-family:'DM Mono',monospace}</style>
</head>
<body class="grid min-h-screen place-items-center bg-[#07090e] px-4 py-10 text-slate-100">
<main class="w-full max-w-md">
    <a href="../index.php" class="mx-auto flex w-fit items-center gap-3">
        <span class="grid size-10 place-items-center rounded-xl border border-cyan-400/15 bg-cyan-400/[0.06] text-xl text-cyan-300">Ξ</span>
        <span class="text-sm font-semibold">ETH<span class="text-cyan-300">crypto</span>hub <span class="mono ml-1 text-[9px] uppercase tracking-[.16em] text-slate-500">Admin</span></span>
    </a>
    <section class="mt-8 rounded-2xl border border-slate-800 bg-[#0f1420] p-6 shadow-2xl shadow-black/30 sm:p-8">
        <div class="mb-6">
            <p class="mono text-[9px] uppercase tracking-[.2em] text-cyan-300/70">Restricted access · audited gateway</p>
            <h1 class="mt-3 text-2xl font-semibold tracking-tight">Administrator sign in</h1>
            <p class="mt-2 text-sm leading-6 text-slate-500">This gateway is reserved for verified, active administrator accounts.</p>
        </div>
        <?php if ($errors !== []): ?>
            <div role="alert" class="mb-5 rounded-xl border border-rose-900/80 bg-rose-950/30 p-3 text-sm text-rose-300">
                <ul class="list-inside list-disc"><?php foreach ($errors as $error): ?><li><?= e($error) ?></li><?php endforeach; ?></ul>
            </div>
        <?php endif; ?>
        <form method="post" action="login.php" class="space-y-4">
            <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
            <div>
                <label for="email" class="mb-1.5 block text-xs text-slate-400">Admin email</label>
                <input id="email" name="email" type="email" autocomplete="username" maxlength="255" required value="<?= e($email) ?>"
                       class="w-full rounded-xl border border-slate-800 bg-[#090c13] px-3.5 py-3 text-sm outline-none transition focus:border-cyan-400/50">
            </div>
            <div>
                <label for="password" class="mb-1.5 block text-xs text-slate-400">Password</label>
                <input id="password" name="password" type="password" autocomplete="current-password" required
                       class="w-full rounded-xl border border-slate-800 bg-[#090c13] px-3.5 py-3 text-sm outline-none transition focus:border-cyan-400/50">
            </div>
            <button type="submit" class="w-full rounded-xl bg-cyan-400 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300">Authenticate securely</button>
        </form>
        <div class="mt-5 flex items-center justify-between border-t border-slate-800 pt-4">
            <span class="mono text-[9px] uppercase tracking-wider text-slate-600">5 attempts · 15 minute lockout</span>
            <a href="../login.php" class="text-xs text-slate-500 transition hover:text-slate-300">User sign in ↗</a>
        </div>
        <p class="mt-4 text-center text-xs text-slate-600">First-time setup? <a href="setup.php" class="text-cyan-300/80 transition hover:text-cyan-200">Create the initial admin account</a></p>
    </section>
</main>
</body>
</html>
