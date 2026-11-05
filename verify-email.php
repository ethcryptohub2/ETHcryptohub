<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

$email = $_GET['email'] ?? '';
$email = is_string($email) ? trim($email) : '';
$code = '';
$errors = [];

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $submittedCsrfToken = $_POST['csrf_token'] ?? null;
    if (!verify_csrf_token(is_string($submittedCsrfToken) ? $submittedCsrfToken : null)) {
        http_response_code(403);
        $errors[] = 'Your form session expired. Refresh the page and try again.';
    } else {
        $submittedEmail = $_POST['email'] ?? null;
        $submittedCode = $_POST['code'] ?? null;
        $email = is_string($submittedEmail) ? trim($submittedEmail) : '';
        $code = is_string($submittedCode) ? trim($submittedCode) : '';

        if (filter_var($email, FILTER_VALIDATE_EMAIL) === false || strlen($email) > 255) {
            $errors[] = 'Enter a valid email address.';
        }
        if (preg_match('/\A[0-9]{6}\z/', $code) !== 1) {
            $errors[] = 'Enter the six-digit verification code.';
        }

        if ($errors === []) {
            try {
                if (verifyEmailCode(db(), $email, $code)) {
                    header('Location: login.php?verified=1', true, 303);
                    exit;
                }
                $errors[] = 'The code is invalid, expired, or temporarily locked. Request a new code and try again.';
                $code = '';
            } catch (PDOException | RuntimeException $exception) {
                error_log('ETHcryptohub email OTP verification error: ' . $exception->getMessage());
                http_response_code(503);
                $errors[] = 'Verification is temporarily unavailable. Please try again later.';
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
    <meta name="theme-color" content="#07090e">
    <title>Email verification | ETHcryptohub</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    </script>
    <script defer src="/_vercel/insights/script.js"></script>
</head>
<body class="grid min-h-screen place-items-center bg-[#07090e] px-4 py-10 text-slate-100">
<main class="w-full max-w-md rounded-2xl border border-slate-800 bg-[#0f1420] p-7 shadow-2xl shadow-black/30 sm:p-8">
    <a href="index.php" class="text-xs font-semibold tracking-[.18em] text-cyan-300">ETHCRYPTOHUB</a>
    <h1 class="mt-5 text-2xl font-semibold">Verify your email</h1>
    <p class="mt-2 text-sm leading-6 text-slate-400">Enter the six-digit code sent to your email address. Codes expire after 10 minutes.</p>

    <?php if ($errors !== []): ?>
        <div role="alert" class="mt-5 rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
            <ul class="list-inside list-disc"><?php foreach ($errors as $error): ?><li><?= e($error) ?></li><?php endforeach; ?></ul>
        </div>
    <?php endif; ?>

    <form method="post" action="verify-email.php" class="mt-6 space-y-4">
        <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
        <div>
            <label for="email" class="mb-1.5 block text-xs text-slate-400">Email address</label>
            <input id="email" name="email" type="email" autocomplete="email" maxlength="255" required value="<?= e($email) ?>"
                   class="w-full rounded-xl border border-slate-800 bg-[#090c13] px-3.5 py-3 text-sm outline-none transition focus:border-cyan-400/50">
        </div>
        <div>
            <label for="code" class="mb-1.5 block text-xs text-slate-400">Six-digit code</label>
            <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required value="<?= e($code) ?>"
                   class="w-full rounded-xl border border-slate-800 bg-[#090c13] px-3.5 py-3 text-center font-mono text-lg tracking-[.4em] outline-none transition focus:border-cyan-400/50">
        </div>
        <button type="submit" class="w-full rounded-xl bg-cyan-400 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300">Verify email</button>
    </form>
    <p class="mt-5 text-center text-sm text-slate-500">Need another code? <a href="resend-verification.php" class="text-cyan-300 hover:text-cyan-200">Resend it</a></p>
    <p class="mt-3 text-center text-sm text-slate-500"><a href="login.php" class="text-slate-400 hover:text-white">Back to sign in</a></p>
</main>
</body>
</html>
