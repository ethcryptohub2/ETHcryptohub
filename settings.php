<?php
declare(strict_types=1);

require_once __DIR__ . '/auth-check.php';
$user = requireUser();

$errors = [];
$success = '';
$handle = (string) ($user['x_handle'] ?? '');

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!verify_csrf_token($_POST['csrf_token'] ?? null)) {
        $errors[] = 'Your form session expired. Please try again.';
    } else {
        $handle = trim((string) ($_POST['x_handle'] ?? ''));
        $handle = ltrim($handle, '@');

        if (strlen($handle) > 100 || ($handle !== '' && preg_match('/^[A-Za-z0-9_]{1,15}$/', $handle) !== 1)) {
            $errors[] = 'Enter a valid X handle (letters, numbers, or underscores; up to 15 characters).';
        } else {
            try {
                $statement = db()->prepare('UPDATE users SET x_handle = :handle WHERE id = :id');
                $statement->execute([
                    ':handle' => $handle !== '' ? $handle : null,
                    ':id' => $_SESSION['user_id'],
                ]);
                $user['x_handle'] = $handle !== '' ? $handle : null;
                $success = 'Your settings have been updated.';
                $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
            } catch (PDOException | RuntimeException $exception) {
                error_log('ETHcryptohub settings update error: ' . $exception->getMessage());
                $errors[] = 'Settings could not be saved. Please try again later.';
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
    <title>Settings | ETHcryptohub</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-slate-950 text-slate-100">
<header class="border-b border-slate-800">
    <nav class="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <a href="dashboard.php" class="font-bold tracking-widest text-cyan-400">ETHCRYPTOHUB</a>
        <div class="flex items-center gap-5">
            <a href="dashboard.php" class="text-sm text-slate-300 hover:text-cyan-300">Dashboard</a>
            <a href="binance-settings.php" class="text-sm text-slate-300 hover:text-cyan-300">Binance API</a>
            <form method="post" action="logout.php">
                <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
                <button type="submit" class="text-sm text-slate-300 hover:text-cyan-300">Sign out</button>
            </form>
        </div>
    </nav>
</header>
<main class="mx-auto max-w-2xl px-4 py-12">
    <h1 class="text-3xl font-semibold">Account settings</h1>
    <p class="mt-2 text-slate-400"><?= e($user['email']) ?></p>
    <?php if ($success !== ''): ?><p role="status" class="mt-6 rounded-lg border border-emerald-800 bg-emerald-950/50 p-3 text-sm text-emerald-300"><?= e($success) ?></p><?php endif; ?>
    <?php if ($errors !== []): ?>
        <div role="alert" class="mt-6 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">
            <ul class="list-inside list-disc"><?php foreach ($errors as $error): ?><li><?= e($error) ?></li><?php endforeach; ?></ul>
        </div>
    <?php endif; ?>
    <section class="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <div class="mb-6 flex items-center justify-between gap-4">
            <h2 class="text-lg font-semibold">X account</h2>
            <?php if ((int) $user['is_x_verified'] === 1): ?>
                <span class="rounded-full border border-emerald-800 bg-emerald-950 px-3 py-1 text-xs font-medium text-emerald-300">Verified</span>
            <?php else: ?>
                <span class="rounded-full border border-amber-800 bg-amber-950 px-3 py-1 text-xs font-medium text-amber-300">Pending Verification</span>
            <?php endif; ?>
        </div>
        <form method="post" action="settings.php" class="space-y-4">
            <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
            <div>
                <label for="x_handle" class="mb-1 block text-sm text-slate-300">X handle</label>
                <div class="flex overflow-hidden rounded-lg border border-slate-700 bg-slate-950 focus-within:border-cyan-400">
                    <span class="px-3 py-2.5 text-slate-500">@</span>
                    <input id="x_handle" name="x_handle" type="text" maxlength="100" value="<?= e($handle) ?>"
                           placeholder="yourhandle" class="min-w-0 flex-1 bg-transparent py-2.5 pr-3 outline-none">
                </div>
                <p class="mt-2 text-xs text-slate-500">Enter up to 15 letters, numbers, or underscores. The leading @ is optional.</p>
            </div>
            <button type="submit" class="rounded-lg bg-cyan-400 px-4 py-2.5 font-semibold text-slate-950 hover:bg-cyan-300">Save settings</button>
        </form>
    </section>
</main>
</body>
</html>
