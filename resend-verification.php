<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

$errors = [];
$email = '';
$notice = '';
$verificationCode = null;
$verificationEmail = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $submittedCsrfToken = $_POST['csrf_token'] ?? null;
    if (!verify_csrf_token(is_string($submittedCsrfToken) ? $submittedCsrfToken : null)) {
        http_response_code(403);
        $errors[] = 'Your form session expired. Refresh the page and try again.';
    } else {
        $submittedEmail = $_POST['email'] ?? null;
        $email = is_string($submittedEmail) ? trim($submittedEmail) : '';
        if (filter_var($email, FILTER_VALIDATE_EMAIL) === false || strlen($email) > 255) {
            $errors[] = 'Enter a valid email address.';
        } else {
            try {
                $pdo = db();
                $ipAddress = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
                if (!allowVerificationResend($pdo, $email, $ipAddress)) {
                    $errors[] = 'Please wait one minute before requesting another verification code.';
                } else {
                    $lookup = $pdo->prepare(
                        'SELECT id, is_email_verified, is_active
                         FROM users WHERE email = :email LIMIT 1'
                    );
                    $lookup->execute([':email' => $email]);
                    $user = $lookup->fetch();

                    if ($user && (int) $user['is_email_verified'] !== 1 && (int) $user['is_active'] === 1) {
                        $deliveryResult = issueEmailVerificationCode($pdo, (int) $user['id'], $email);
                        if (is_string($deliveryResult)) {
                            $verificationCode = $deliveryResult;
                            $verificationEmail = $email;
                        } elseif ($deliveryResult === false) {
                            error_log('ETHcryptohub verification resend transport is not configured or failed.');
                        }
                    }

                    $notice = 'For security, account status is not disclosed. If an active account needs verification, a code will be sent when email delivery is configured.';
                    $email = '';
                    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
                }
            } catch (PDOException | RuntimeException $exception) {
                error_log('ETHcryptohub verification resend error: ' . $exception->getMessage());
                http_response_code(503);
                $errors[] = 'Verification email service is temporarily unavailable. Please try again later.';
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
    <title>Resend verification | ETHcryptohub</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="grid min-h-screen place-items-center bg-[#07090e] px-4 py-10 text-slate-100">
<main class="w-full max-w-md rounded-2xl border border-slate-800 bg-[#0f1420] p-7 shadow-2xl shadow-black/30 sm:p-8">
    <a href="index.php" class="text-xs font-semibold tracking-[.18em] text-cyan-300">ETHCRYPTOHUB</a>
    <h1 class="mt-5 text-2xl font-semibold">Resend verification code</h1>
    <p class="mt-2 text-sm leading-6 text-slate-400">Enter your signup email to request a new six-digit code.</p>
    <?php if (isLoopbackRequest() && trim((string) (getenv('RESEND_API_KEY') ?: '')) === ''): ?>
        <p class="mt-4 rounded-xl border border-amber-700/60 bg-amber-950/30 p-3 text-sm text-amber-200">
            No email is sent in local development. If the account needs verification, the development-only code is shown here.
        </p>
    <?php endif; ?>

    <?php if ($notice !== ''): ?>
        <p role="status" class="mt-5 rounded-xl border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-300"><?= e($notice) ?></p>
        <?php if (is_string($verificationCode)): ?>
            <p class="mt-3 rounded-xl border border-amber-700/60 bg-amber-950/30 p-3 text-sm text-amber-200">
                Development-only code: <strong class="font-mono tracking-widest"><?= e($verificationCode) ?></strong>
            </p>
            <a href="verify-email.php?email=<?= rawurlencode($verificationEmail) ?>" class="mt-3 inline-flex w-full items-center justify-center rounded-lg border border-emerald-700/70 bg-emerald-950/30 px-4 py-2.5 text-sm font-medium text-emerald-200 hover:bg-emerald-900/40">Enter verification code</a>
        <?php endif; ?>
    <?php endif; ?>

    <?php if ($errors !== []): ?>
        <div role="alert" class="mt-5 rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
            <ul class="list-inside list-disc"><?php foreach ($errors as $error): ?><li><?= e($error) ?></li><?php endforeach; ?></ul>
        </div>
    <?php endif; ?>

    <form method="post" action="resend-verification.php" class="mt-6 space-y-4">
        <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
        <div>
            <label for="email" class="mb-1.5 block text-xs text-slate-400">Email address</label>
            <input id="email" name="email" type="email" autocomplete="email" maxlength="255" required value="<?= e($email) ?>"
                   class="w-full rounded-xl border border-slate-800 bg-[#090c13] px-3.5 py-3 text-sm outline-none transition focus:border-cyan-400/50">
        </div>
        <button type="submit" class="w-full rounded-xl bg-cyan-400 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300">Send verification code</button>
    </form>
    <p class="mt-5 text-center text-sm text-slate-500"><a href="login.php" class="text-cyan-300 hover:text-cyan-200">Back to sign in</a></p>
</main>
</body>
</html>
