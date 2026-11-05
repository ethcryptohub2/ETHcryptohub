<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

$errors = [];
$email = '';
$fullName = '';
$countryCode = '+91';
$phoneNumber = '';
$verificationEmail = '';
$verificationCode = null;
$countryCodes = ['+91', '+1', '+44', '+971'];

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $submittedCsrfToken = $_POST['csrf_token'] ?? null;
    if (!verify_csrf_token(is_string($submittedCsrfToken) ? $submittedCsrfToken : null)) {
        $errors[] = 'Your form session expired. Please try again.';
    } else {
        $submittedEmail = $_POST['email'] ?? null;
        $submittedName = $_POST['full_name'] ?? null;
        $submittedCountryCode = $_POST['country_code'] ?? null;
        $submittedPhone = $_POST['phone_number'] ?? null;
        $submittedPassword = $_POST['password'] ?? null;
        $email = is_string($submittedEmail) ? trim($submittedEmail) : '';
        $fullName = is_string($submittedName) ? trim($submittedName) : '';
        $countryCode = is_string($submittedCountryCode) ? $submittedCountryCode : '+91';
        $phoneNumber = is_string($submittedPhone) ? trim($submittedPhone) : '';
        $password = is_string($submittedPassword) ? $submittedPassword : '';

        if (filter_var($email, FILTER_VALIDATE_EMAIL) === false || strlen($email) > 255) {
            $errors[] = 'Enter a valid email address.';
        }
        if (strlen($password) < 8) {
            $errors[] = 'Password must be at least 8 characters long.';
        } elseif (strlen($password) > 72) {
            $errors[] = 'Password must be 72 bytes or fewer.';
        }
        if (strlen($fullName) > 150) {
            $errors[] = 'Full name must be 150 characters or fewer.';
        }
        if (!in_array($countryCode, $countryCodes, true)) {
            $errors[] = 'Select a valid country calling code.';
        }
        if ($phoneNumber !== '' && !preg_match('/^[0-9]{10}$/', $phoneNumber)) {
            $errors[] = 'Phone number must contain exactly 10 digits.';
        }

        if ($errors === []) {
            $passwordHash = password_hash($password, PASSWORD_BCRYPT);

            if ($passwordHash === false) {
                throw new RuntimeException('Password hashing failed.');
            }

            try {
                $pdo = db();
                $statement = $pdo->prepare(
                    'INSERT INTO users (email, password_hash, full_name, country_code, phone_number)
                     VALUES (:email, :password_hash, :full_name, :country_code, :phone_number)'
                );
                $statement->execute([
                    ':email' => $email,
                    ':password_hash' => $passwordHash,
                    ':full_name' => $fullName !== '' ? $fullName : null,
                    ':country_code' => $countryCode,
                    ':phone_number' => $phoneNumber !== '' ? $phoneNumber : null,
                ]);

                $verificationEmail = $email;
                if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'pgsql') {
                    $lookup = $pdo->prepare('SELECT id FROM users WHERE email = :email LIMIT 1');
                    $lookup->execute([':email' => $email]);
                    $userId = (int) $lookup->fetchColumn();
                } else {
                    $userId = (int) $pdo->lastInsertId();
                }
                if ($userId < 1) {
                    throw new RuntimeException('The new account ID could not be loaded.');
                }
                $deliveryResult = issueEmailVerificationCode($pdo, $userId, $email);
                $verificationCode = is_string($deliveryResult) ? $deliveryResult : null;
                $success = is_string($deliveryResult)
                    ? 'Your account was created. Enter the development-only code below to verify it.'
                    : ($deliveryResult === true
                        ? 'Your account was created. A verification code was submitted for email delivery. Check your inbox and spam folder.'
                        : 'Your account was created, but the verification code could not be sent. Configure email delivery or request another code.');
                $email = '';
                $fullName = '';
                $phoneNumber = '';
                $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
            } catch (PDOException | RuntimeException $exception) {
                if ($exception instanceof PDOException && in_array((string) $exception->getCode(), ['23000', '23505'], true)) {
                    $errors[] = 'An account with that email address already exists.';
                } else {
                    error_log('ETHcryptohub signup database error: ' . $exception->getMessage());
                    $errors[] = 'Registration could not be completed. Please try again later.';
                }
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
    <title>Create account | ETHcryptohub</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    </script>
    <script defer src="/_vercel/insights/script.js"></script>
</head>
<body class="min-h-screen bg-slate-950 text-slate-100">
<main class="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4 py-12">
    <section class="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl shadow-cyan-950/20">
        <a href="signup.php" class="text-sm font-bold tracking-widest text-cyan-400">ETHCRYPTOHUB</a>
        <h1 class="mt-5 text-3xl font-semibold">Create your account</h1>
        <p class="mt-2 text-sm text-slate-400">Secure access to your crypto dashboard.</p>

        <?php if (isset($success)): ?>
            <p role="status" class="mt-6 rounded-lg border border-emerald-800 bg-emerald-950/50 p-3 text-sm text-emerald-300"><?= e($success) ?></p>
            <?php if (is_string($verificationCode)): ?>
                <p class="mt-3 rounded-lg border border-amber-700/70 bg-amber-950/30 p-3 text-sm text-amber-200">
                    Development-only code: <strong class="font-mono tracking-widest"><?= e($verificationCode) ?></strong>
                </p>
            <?php endif; ?>
            <a href="verify-email.php?email=<?= rawurlencode($verificationEmail) ?>" class="mt-3 inline-flex w-full items-center justify-center rounded-lg border border-emerald-700/70 bg-emerald-950/30 px-4 py-2.5 text-sm font-medium text-emerald-200 hover:bg-emerald-900/40">Enter verification code</a>
        <?php endif; ?>
        <?php if ($errors !== []): ?>
            <div role="alert" class="mt-6 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
                <ul class="list-inside list-disc">
                    <?php foreach ($errors as $error): ?><li><?= e($error) ?></li><?php endforeach; ?>
                </ul>
            </div>
        <?php endif; ?>

        <form method="post" action="signup.php" class="mt-6 space-y-4">
            <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
            <div>
                <label for="email" class="mb-1 block text-sm text-slate-300">Email</label>
                <input id="email" name="email" type="email" autocomplete="email" maxlength="255" required value="<?= e($email) ?>"
                       class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 outline-none focus:border-cyan-400">
            </div>
            <div>
                <label for="password" class="mb-1 block text-sm text-slate-300">Password</label>
                <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required
                       class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 outline-none focus:border-cyan-400">
            </div>
            <div>
                <label for="full_name" class="mb-1 block text-sm text-slate-300">Full name <span class="text-slate-500">(optional)</span></label>
                <input id="full_name" name="full_name" type="text" autocomplete="name" maxlength="150" value="<?= e($fullName) ?>"
                       class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 outline-none focus:border-cyan-400">
            </div>
            <div>
                <label for="phone_number" class="mb-1 block text-sm text-slate-300">Phone <span class="text-slate-500">(optional)</span></label>
                <div class="flex gap-2">
                    <select id="country_code" name="country_code" class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 focus:border-cyan-400">
                        <?php foreach ($countryCodes as $code): ?>
                            <option value="<?= e($code) ?>"<?= $countryCode === $code ? ' selected' : '' ?>><?= e($code) ?></option>
                        <?php endforeach; ?>
                    </select>
                    <input id="phone_number" name="phone_number" type="tel" inputmode="numeric" autocomplete="tel-national"
                           pattern="[0-9]{10}" maxlength="10" placeholder="10 digits" value="<?= e($phoneNumber) ?>"
                           class="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 outline-none focus:border-cyan-400">
                </div>
            </div>
            <button type="submit" class="w-full rounded-lg bg-cyan-400 px-4 py-3 font-semibold text-slate-950 hover:bg-cyan-300">Create account</button>
        </form>
        <p class="mt-6 text-center text-sm text-slate-400">Already registered? <a href="login.php" class="text-cyan-400 hover:text-cyan-300">Sign in</a> <span class="text-slate-600">·</span> <a href="resend-verification.php" class="text-cyan-400 hover:text-cyan-300">Resend confirmation</a></p>
    </section>
</main>
</body>
</html>
