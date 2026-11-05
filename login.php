<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

$errors = [];
$email = '';
$emailUnverified = false;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $submittedCsrfToken = $_POST['csrf_token'] ?? null;
    if (!verify_csrf_token(is_string($submittedCsrfToken) ? $submittedCsrfToken : null)) {
        $errors[] = 'Your form session expired. Please try again.';
    } else {
        $submittedEmail = $_POST['email'] ?? null;
        $submittedPassword = $_POST['password'] ?? null;
        $email = is_string($submittedEmail) ? trim($submittedEmail) : '';
        $password = is_string($submittedPassword) ? $submittedPassword : '';

        if (filter_var($email, FILTER_VALIDATE_EMAIL) === false || strlen($email) > 255 || $password === '' || strlen($password) > 72) {
            $errors[] = 'Email or password is incorrect.';
        } else {
            try {
                $statement = db()->prepare('SELECT id, password_hash, is_email_verified, is_active, role FROM users WHERE email = :email LIMIT 1');
                $statement->execute([':email' => $email]);
                $user = $statement->fetch();

                if (!$user || !password_verify($password, $user['password_hash'])) {
                    $errors[] = 'Email or password is incorrect.';
                } elseif ((int) $user['is_email_verified'] !== 1) {
                    $emailUnverified = true;
                    $errors[] = 'Please verify your email address before signing in.';
                } elseif ((int) $user['is_active'] !== 1) {
                    $errors[] = 'This account is currently unavailable. Contact support for assistance.';
                } else {
                    $update = db()->prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = :id');
                    $update->execute([':id' => $user['id']]);
                    session_regenerate_id(true);
                    $_SESSION['user_id'] = (int) $user['id'];
                    $_SESSION['user_role'] = $user['role'];
                    $_SESSION['last_activity'] = time();
                    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
                    header('Location: dashboard.php', true, 303);
                    exit;
                }
            } catch (PDOException | RuntimeException $exception) {
                error_log('ETHcryptohub login database error: ' . $exception->getMessage());
                $errors[] = 'Sign in is temporarily unavailable. Please try again later.';
            }
        }
    }
}
?>
<!doctype html>
<html lang="en" class="dark">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in | ETHcryptohub</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    </script>
    <script defer src="/_vercel/insights/script.js"></script>
</head>
<body class="grid min-h-screen place-items-center bg-slate-950 px-4 text-slate-100">
<main class="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/90 p-8 shadow-2xl shadow-cyan-950/20">
    <a href="signup.php" class="text-sm font-bold tracking-widest text-cyan-400">ETHCRYPTOHUB</a>
    <h1 class="mt-5 text-3xl font-semibold">Welcome back</h1>
    <?php if (($_GET['verified'] ?? '') === '1'): ?>
        <p role="status" class="mt-5 rounded-lg border border-emerald-800 bg-emerald-950/50 p-3 text-sm text-emerald-300">Email verified. You can now sign in.</p>
    <?php endif; ?>
    <?php if ($errors !== []): ?>
        <div role="alert" class="mt-5 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
            <ul class="list-inside list-disc"><?php foreach ($errors as $error): ?><li><?= e($error) ?></li><?php endforeach; ?></ul>
            <?php if ($emailUnverified): ?>
                <a class="mt-2 inline-block text-sm underline" href="resend-verification.php">Resend verification code</a>
            <?php endif; ?>
        </div>
    <?php endif; ?>
    <form method="post" action="login.php" class="mt-6 space-y-4">
        <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
        <div>
            <label for="email" class="mb-1 block text-sm text-slate-300">Email</label>
            <input id="email" name="email" type="email" autocomplete="email" maxlength="255" required value="<?= e($email) ?>"
                   class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 outline-none focus:border-cyan-400">
        </div>
        <div>
            <label for="password" class="mb-1 block text-sm text-slate-300">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required
                   class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 outline-none focus:border-cyan-400">
        </div>
        <button type="submit" class="w-full rounded-lg bg-cyan-400 px-4 py-3 font-semibold text-slate-950 hover:bg-cyan-300">Sign in</button>
    </form>
    <p class="mt-6 text-center text-sm text-slate-400">New to ETHcryptohub? <a href="signup.php" class="text-cyan-400 hover:text-cyan-300">Create an account</a></p>
</main>
</body>
</html>
