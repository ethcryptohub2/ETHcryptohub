<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/config.php';

$localSetup = isLoopbackRequest();
$configuredSetupToken = getenv('ADMIN_SETUP_TOKEN') ?: '';
$errors = [];
$email = '';
$setupComplete = false;
$setupUnavailable = false;

if (!$localSetup && $configuredSetupToken === '') {
    http_response_code(404);
    exit('Not found.');
}

try {
    $adminCountStatement = db()->prepare("SELECT COUNT(*) FROM users WHERE role = 'admin'");
    $adminCountStatement->execute();
    $setupUnavailable = (int) $adminCountStatement->fetchColumn() > 0;
} catch (PDOException | RuntimeException $exception) {
    error_log('ETHcryptohub admin setup database error: ' . $exception->getMessage());
    http_response_code(503);
    exit('Admin setup is temporarily unavailable.');
}

if ($setupUnavailable) {
    http_response_code(410);
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $submittedEmail = $_POST['email'] ?? null;
    $submittedPassword = $_POST['password'] ?? null;
    $submittedConfirmation = $_POST['password_confirmation'] ?? null;
    $submittedSetupValue = $_POST['setup_token'] ?? null;
    $submittedCsrfValue = $_POST['csrf_token'] ?? null;
    $email = is_string($submittedEmail) ? trim($submittedEmail) : '';
    $password = is_string($submittedPassword) ? $submittedPassword : '';
    $passwordConfirmation = is_string($submittedConfirmation) ? $submittedConfirmation : '';
    $submittedSetupToken = is_string($submittedSetupValue) ? $submittedSetupValue : '';

    $tokenValid = $localSetup
        || ($configuredSetupToken !== ''
            && $submittedSetupToken !== ''
            && hash_equals($configuredSetupToken, $submittedSetupToken));

    if (!$tokenValid) {
        http_response_code(403);
        $errors[] = 'The setup authorization token is invalid.';
    } elseif (!verify_csrf_token(is_string($submittedCsrfValue) ? $submittedCsrfValue : null)) {
        http_response_code(403);
        $errors[] = 'Your form session expired. Refresh the page and try again.';
    } elseif (filter_var($email, FILTER_VALIDATE_EMAIL) === false || strlen($email) > 255) {
        $errors[] = 'Enter a valid administrator email address.';
    } elseif (strlen($password) < 12 || strlen($password) > 72) {
        $errors[] = 'Choose a password between 12 and 72 bytes long.';
    } elseif (!hash_equals($password, $passwordConfirmation)) {
        $errors[] = 'The password confirmation does not match.';
    } else {
        try {
            $pdo = db();
            $pdo->beginTransaction();

            $lockSuffix = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite' ? '' : ' FOR UPDATE';
            $adminCheck = $pdo->prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1" . $lockSuffix);
            $adminCheck->execute();
            if ($adminCheck->fetch()) {
                $pdo->rollBack();
                $setupUnavailable = true;
                http_response_code(410);
            } else {
                $passwordHash = password_hash($password, PASSWORD_BCRYPT);
                if ($passwordHash === false) {
                    throw new RuntimeException('Administrator password hashing failed.');
                }

                $existing = $pdo->prepare('SELECT id FROM users WHERE email = :email LIMIT 1');
                $existing->execute([':email' => $email]);
                $existingUserId = $existing->fetchColumn();

                if ($existingUserId !== false) {
                    $promote = $pdo->prepare(
                        "UPDATE users SET password_hash = :password_hash, role = 'admin',
                         is_active = 1, is_email_verified = 1, email_verification_token = NULL
                         WHERE id = :id"
                    );
                    $promote->execute([':password_hash' => $passwordHash, ':id' => $existingUserId]);
                } else {
                    $insert = $pdo->prepare(
                        "INSERT INTO users (
                            email, password_hash, full_name, country_code, role,
                            is_active, is_email_verified, email_verification_token
                         ) VALUES (
                            :email, :password_hash, 'ETHcryptohub Administrator', '+91',
                            'admin', 1, 1, NULL
                         )"
                    );
                    $insert->execute([':email' => $email, ':password_hash' => $passwordHash]);
                }

                $pdo->commit();
                $setupComplete = true;
                $setupUnavailable = true;
                http_response_code(201);
                $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
            }
        } catch (PDOException | RuntimeException $exception) {
            if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log('ETHcryptohub admin bootstrap error: ' . $exception->getMessage());
            http_response_code(503);
            $errors[] = 'Administrator setup could not be completed. Check the database configuration and try again.';
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
    <title>One-time admin setup | ETHcryptohub</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>body{font-family:'Space Grotesk',sans-serif;background:#07090e}.mono{font-family:'DM Mono',monospace}</style>
    <script>
        window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    </script>
    <script defer src="/_vercel/insights/script.js"></script>
</head>
<body class="grid min-h-screen place-items-center bg-[#07090e] px-4 py-10 text-slate-100">
<main class="w-full max-w-lg">
    <a href="../index.php" class="mx-auto flex w-fit items-center gap-3">
        <span class="grid size-10 place-items-center rounded-xl border border-cyan-400/15 bg-cyan-400/[0.06] text-xl text-cyan-300">Ξ</span>
        <span class="text-sm font-semibold">ETH<span class="text-cyan-300">crypto</span>hub <span class="mono ml-1 text-[9px] uppercase tracking-[.15em] text-slate-500">Setup</span></span>
    </a>
    <section class="mt-8 rounded-2xl border border-slate-800 bg-[#0f1420] p-6 shadow-2xl shadow-black/30 sm:p-8">
        <p class="mono text-[9px] uppercase tracking-[.2em] text-cyan-300/70">One-time secure bootstrap</p>
        <h1 class="mt-3 text-2xl font-semibold tracking-tight">Create administrator</h1>
        <?php if ($setupComplete): ?>
            <p role="status" class="mt-5 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-4 text-sm leading-6 text-emerald-200">
                Administrator <strong><?= e($email) ?></strong> is ready. Save your password in a password manager and sign in below.
            </p>
            <a href="login.php" class="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-cyan-400 py-3 text-sm font-semibold text-slate-950 hover:bg-cyan-300">Go to admin sign in</a>
        <?php elseif ($setupUnavailable): ?>
            <p role="status" class="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-4 text-sm leading-6 text-amber-200">
                Initial admin setup is already complete and has been disabled. Sign in through the admin gateway.
            </p>
            <a href="login.php" class="mt-5 inline-flex w-full items-center justify-center rounded-xl border border-slate-700 py-3 text-sm text-slate-200 hover:border-cyan-400/30">Go to admin sign in</a>
        <?php else: ?>
            <p class="mt-2 text-sm leading-6 text-slate-400">
                Your email is the admin username. If it matches an existing account, that account will be promoted and its password reset. Setup locks permanently after the first administrator is created.
            </p>
            <?php if (!$localSetup): ?>
                <p class="mt-4 rounded-lg border border-amber-400/15 bg-amber-400/[0.04] p-3 text-xs leading-5 text-amber-200">This is a one-time production operation. Keep the setup token private and remove ADMIN_SETUP_TOKEN after setup.</p>
            <?php endif; ?>
            <?php if ($errors !== []): ?>
                <div role="alert" class="mt-5 rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
                    <ul class="list-inside list-disc"><?php foreach ($errors as $error): ?><li><?= e($error) ?></li><?php endforeach; ?></ul>
                </div>
            <?php endif; ?>
            <form method="post" action="setup.php" class="mt-6 space-y-4">
                <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
                <?php if (!$localSetup): ?>
                    <div>
                        <label for="setup_token" class="mb-1.5 block text-xs text-slate-400">One-time setup token</label>
                        <input id="setup_token" name="setup_token" type="password" autocomplete="off" required
                               class="w-full rounded-xl border border-slate-800 bg-[#090c13] px-3.5 py-3 text-sm outline-none focus:border-cyan-400/50">
                    </div>
                <?php endif; ?>
                <div>
                    <label for="email" class="mb-1.5 block text-xs text-slate-400">Admin username (email)</label>
                    <input id="email" name="email" type="email" maxlength="255" autocomplete="username" required value="<?= e($email) ?>"
                           class="w-full rounded-xl border border-slate-800 bg-[#090c13] px-3.5 py-3 text-sm outline-none focus:border-cyan-400/50">
                </div>
                <div>
                    <label for="password" class="mb-1.5 block text-xs text-slate-400">Admin password</label>
                    <input id="password" name="password" type="password" minlength="12" maxlength="72" autocomplete="new-password" required
                           class="w-full rounded-xl border border-slate-800 bg-[#090c13] px-3.5 py-3 text-sm outline-none focus:border-cyan-400/50">
                </div>
                <div>
                    <label for="password_confirmation" class="mb-1.5 block text-xs text-slate-400">Confirm password</label>
                    <input id="password_confirmation" name="password_confirmation" type="password" minlength="12" maxlength="72" autocomplete="new-password" required
                           class="w-full rounded-xl border border-slate-800 bg-[#090c13] px-3.5 py-3 text-sm outline-none focus:border-cyan-400/50">
                </div>
                <button type="submit" class="w-full rounded-xl bg-cyan-400 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300">Create admin account</button>
            </form>
        <?php endif; ?>
    </section>
</main>
</body>
</html>
