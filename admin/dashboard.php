<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/auth-check.php';
$admin = requireAdmin();
$flash = $_SESSION['admin_flash'] ?? null;
unset($_SESSION['admin_flash']);

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!verify_csrf_token($_POST['csrf_token'] ?? null)) {
        http_response_code(403);
        $flash = ['type' => 'error', 'message' => 'The form token is invalid or expired. Refresh the page before trying again.'];
    } else {
        $action = $_POST['action'] ?? null;
        $targetId = filter_var($_POST['user_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);

        if (!is_string($action) || $targetId === false) {
            http_response_code(400);
            $flash = ['type' => 'error', 'message' => 'The requested action is invalid.'];
        } elseif ((int) $targetId === (int) $admin['id'] && in_array($action, ['toggle_active', 'delete_user'], true)) {
            http_response_code(400);
            $flash = ['type' => 'error', 'message' => 'You cannot suspend or delete your own administrator account.'];
        } else {
            try {
                $pdo = db();
                if ($action === 'toggle_x_verification') {
                    $statement = $pdo->prepare('UPDATE users SET is_x_verified = 1 - is_x_verified WHERE id = :id');
                    $statement->execute([':id' => $targetId]);
                    $message = 'X verification status updated.';
                } elseif ($action === 'toggle_active') {
                    $statement = $pdo->prepare('UPDATE users SET is_active = 1 - is_active WHERE id = :id AND id <> :admin_id');
                    $statement->execute([':id' => $targetId, ':admin_id' => $admin['id']]);
                    $message = 'Account status updated.';
                } elseif ($action === 'delete_user') {
                    $statement = $pdo->prepare('DELETE FROM users WHERE id = :id AND id <> :admin_id');
                    $statement->execute([':id' => $targetId, ':admin_id' => $admin['id']]);
                    $message = 'User account deleted.';
                } else {
                    http_response_code(400);
                    $flash = ['type' => 'error', 'message' => 'The requested action is not supported.'];
                    $_SESSION['admin_flash'] = $flash;
                    header('Location: dashboard.php', true, 303);
                    exit;
                }

                if ($statement instanceof PDOStatement && $statement->rowCount() > 0) {
                    $_SESSION['admin_flash'] = ['type' => 'success', 'message' => $message];
                    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
                } elseif ($statement instanceof PDOStatement && $flash === null) {
                    $_SESSION['admin_flash'] = ['type' => 'error', 'message' => 'No matching user was changed.'];
                }
                header('Location: dashboard.php', true, 303);
                exit;
            } catch (PDOException | RuntimeException $exception) {
                error_log('ETHcryptohub admin user-management error: ' . $exception->getMessage());
                http_response_code(503);
                exit('The requested user-management action could not be completed. Please try again later.');
            }
        }
    }
}

try {
    $metricStatement = db()->prepare(
        'SELECT COUNT(*) AS total_users,
                COALESCE(SUM(is_email_verified = 1), 0) AS verified_emails,
                COALESCE(SUM(is_x_verified = 1), 0) AS x_verified_users,
                COALESCE(SUM(is_active = 0), 0) AS inactive_users
         FROM users'
    );
    $metricStatement->execute();
    $metrics = $metricStatement->fetch();

    $usersStatement = db()->prepare(
        'SELECT id, email, full_name, country_code, phone_number, x_handle,
                is_x_verified, is_email_verified, is_active, role, created_at
         FROM users ORDER BY created_at DESC, id DESC'
    );
    $usersStatement->execute();
    $users = $usersStatement->fetchAll();
} catch (PDOException | RuntimeException $exception) {
    error_log('ETHcryptohub admin dashboard database error: ' . $exception->getMessage());
    http_response_code(503);
    exit('The admin command center is temporarily unavailable. Please try again later.');
}
?>
<!doctype html>
<html lang="en" class="dark">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#07090e">
    <title>Admin command center | ETHcryptohub</title>
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
<body class="min-h-screen bg-[#07090e] text-slate-100 antialiased">
<header class="sticky top-0 z-20 border-b border-slate-800 bg-[#07090e]/95 backdrop-blur-xl">
    <nav class="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8" aria-label="Admin navigation">
        <a href="dashboard.php" class="flex items-center gap-3">
            <span class="grid size-9 place-items-center rounded-xl border border-cyan-400/15 bg-cyan-400/[0.06] text-lg text-cyan-300">Ξ</span>
            <span class="text-sm font-semibold">ETH<span class="text-cyan-300">crypto</span>hub <span class="mono ml-1 text-[9px] uppercase tracking-[.15em] text-slate-500">Control</span></span>
        </a>
        <div class="flex flex-wrap items-center gap-2 sm:gap-4">
            <span class="hidden max-w-[220px] truncate text-xs text-slate-400 sm:inline"><?= e($admin['email']) ?></span>
            <a href="../dashboard.php" class="rounded-lg border border-slate-800 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-400/25 hover:text-cyan-200">User view ↗</a>
            <form method="post" action="../logout.php">
                <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
                <button type="submit" class="rounded-lg border border-slate-800 px-3 py-2 text-xs text-slate-400 transition hover:border-rose-400/25 hover:text-rose-300">Sign out</button>
            </form>
        </div>
    </nav>
</header>

<main class="mx-auto max-w-[1800px] px-4 py-7 sm:px-6 lg:px-8">
    <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
            <p class="mono text-[10px] uppercase tracking-[.2em] text-cyan-300/70">Restricted operations · administrator</p>
            <h1 class="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Command center</h1>
        </div>
        <p class="mono text-[10px] text-slate-500">USER DIRECTORY · <?= e(count($users)) ?> RECORDS</p>
    </div>

    <?php if (is_array($flash) && isset($flash['message'])): ?>
        <div role="<?= ($flash['type'] ?? '') === 'success' ? 'status' : 'alert' ?>"
             class="mb-5 rounded-xl border px-4 py-3 text-sm <?= ($flash['type'] ?? '') === 'success' ? 'border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-300' : 'border-rose-400/20 bg-rose-400/[0.05] text-rose-300' ?>">
            <?= e($flash['message']) ?>
        </div>
    <?php endif; ?>

    <section aria-label="User metrics" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <?php
        $metricCards = [
            ['Registered users', $metrics['total_users'], 'TOTAL ACCOUNTS', 'text-cyan-300'],
            ['Verified emails', $metrics['verified_emails'], 'EMAIL CONFIRMED', 'text-emerald-300'],
            ['X-verified users', $metrics['x_verified_users'], 'IDENTITY BADGE', 'text-sky-300'],
            ['Inactive accounts', $metrics['inactive_users'], 'SUSPENDED', 'text-amber-300'],
        ];
        foreach ($metricCards as [$label, $value, $caption, $color]):
        ?>
            <article class="rounded-2xl border border-slate-800 bg-[#0f1420] p-5">
                <p class="text-xs text-slate-500"><?= e($label) ?></p>
                <div class="mt-4 flex items-end justify-between">
                    <p class="text-3xl font-medium tracking-tight <?= e($color) ?>"><?= e($value) ?></p>
                    <p class="mono text-[9px] tracking-[.12em] text-slate-600"><?= e($caption) ?></p>
                </div>
            </article>
        <?php endforeach; ?>
    </section>

    <section class="mt-5 overflow-hidden rounded-2xl border border-slate-800 bg-[#0f1420]">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
            <div>
                <h2 class="text-sm font-semibold">User database</h2>
                <p class="mt-1 text-xs text-slate-500">Account identity, verification, and access controls</p>
            </div>
            <span class="mono rounded-md border border-slate-700 px-2.5 py-1.5 text-[9px] text-slate-500">LIVE DATABASE</span>
        </div>
        <?php if ($users === []): ?>
            <p class="px-5 py-12 text-center text-sm text-slate-500">No user records found.</p>
        <?php else: ?>
            <div class="overflow-x-auto">
                <table class="w-full min-w-[1250px] text-left text-xs">
                    <thead class="mono border-b border-slate-800 text-[9px] uppercase tracking-[.12em] text-slate-500">
                    <tr>
                        <th class="px-4 py-3 font-normal">ID</th>
                        <th class="px-4 py-3 font-normal">Account</th>
                        <th class="px-4 py-3 font-normal">Contact</th>
                        <th class="px-4 py-3 font-normal">X identity</th>
                        <th class="px-4 py-3 font-normal">Email status</th>
                        <th class="px-4 py-3 font-normal">Role</th>
                        <th class="px-4 py-3 font-normal">Registered</th>
                        <th class="px-4 py-3 font-normal">Account access</th>
                        <th class="px-4 py-3 font-normal">Admin actions</th>
                    </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-800/80">
                    <?php foreach ($users as $row): ?>
                        <tr class="align-top transition hover:bg-white/[0.015] <?= (int) $row['is_active'] !== 1 ? 'bg-rose-400/[0.018]' : '' ?>">
                            <td class="mono px-4 py-4 text-slate-500">#<?= e($row['id']) ?></td>
                            <td class="px-4 py-4">
                                <p class="max-w-[230px] break-all font-medium text-slate-200"><?= e($row['email']) ?></p>
                                <p class="mt-1 text-slate-500"><?= $row['full_name'] !== null && $row['full_name'] !== '' ? e($row['full_name']) : '—' ?></p>
                            </td>
                            <td class="px-4 py-4 text-slate-300">
                                <?= $row['phone_number'] !== null ? e($row['country_code'] . ' ' . $row['phone_number']) : '—' ?>
                            </td>
                            <td class="px-4 py-4">
                                <p class="text-slate-300"><?= $row['x_handle'] !== null && $row['x_handle'] !== '' ? '@' . e($row['x_handle']) : '—' ?></p>
                                <form method="post" action="dashboard.php" class="mt-2">
                                    <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
                                    <input type="hidden" name="user_id" value="<?= e($row['id']) ?>">
                                    <input type="hidden" name="action" value="toggle_x_verification">
                                    <button type="submit" class="rounded-md border px-2 py-1 text-[9px] transition <?= (int) $row['is_x_verified'] === 1 ? 'border-emerald-400/15 text-emerald-300 hover:border-rose-400/25 hover:text-rose-300' : 'border-slate-700 text-slate-400 hover:border-emerald-400/25 hover:text-emerald-300' ?>">
                                        <?= (int) $row['is_x_verified'] === 1 ? 'Revoke X verification' : 'Approve X verification' ?>
                                    </button>
                                </form>
                            </td>
                            <td class="px-4 py-4">
                                <?php if ((int) $row['is_email_verified'] === 1): ?>
                                    <span class="rounded-full border border-emerald-400/15 bg-emerald-400/[0.04] px-2 py-1 text-[9px] text-emerald-300">Verified</span>
                                <?php else: ?>
                                    <span class="rounded-full border border-amber-400/15 bg-amber-400/[0.04] px-2 py-1 text-[9px] text-amber-300">Pending</span>
                                <?php endif; ?>
                            </td>
                            <td class="px-4 py-4"><span class="rounded-md border px-2 py-1 text-[9px] <?= $row['role'] === 'admin' ? 'border-cyan-400/20 bg-cyan-400/[0.04] text-cyan-300' : 'border-slate-700 text-slate-400' ?>"><?= e(ucfirst($row['role'])) ?></span></td>
                            <td class="mono whitespace-nowrap px-4 py-4 text-[10px] text-slate-500"><?= e($row['created_at']) ?></td>
                            <td class="px-4 py-4">
                                <?php if ((int) $row['is_active'] === 1): ?>
                                    <span class="text-[10px] text-emerald-300">Active</span>
                                <?php else: ?>
                                    <span class="text-[10px] text-rose-300">Suspended</span>
                                <?php endif; ?>
                                <?php if ((int) $row['id'] !== (int) $admin['id']): ?>
                                    <form method="post" action="dashboard.php" class="mt-2">
                                        <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
                                        <input type="hidden" name="user_id" value="<?= e($row['id']) ?>">
                                        <input type="hidden" name="action" value="toggle_active">
                                        <button type="submit" class="rounded-md border border-slate-700 px-2 py-1 text-[9px] text-slate-400 transition hover:border-amber-400/25 hover:text-amber-300">
                                            <?= (int) $row['is_active'] === 1 ? 'Suspend account' : 'Reactivate account' ?>
                                        </button>
                                    </form>
                                <?php else: ?>
                                    <p class="mt-2 text-[9px] text-slate-600">Current admin</p>
                                <?php endif; ?>
                            </td>
                            <td class="px-4 py-4">
                                <?php if ((int) $row['id'] !== (int) $admin['id']): ?>
                                    <form method="post" action="dashboard.php" onsubmit="return confirm('Permanently delete this account? This cannot be undone.');">
                                        <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
                                        <input type="hidden" name="user_id" value="<?= e($row['id']) ?>">
                                        <input type="hidden" name="action" value="delete_user">
                                        <button type="submit" class="rounded-md border border-rose-400/15 px-2.5 py-1.5 text-[9px] text-rose-300 transition hover:border-rose-400/35 hover:bg-rose-400/[0.05]">Delete user</button>
                                    </form>
                                <?php else: ?>
                                    <span class="text-[9px] text-slate-600">Protected</span>
                                <?php endif; ?>
                            </td>
                        </tr>
                    <?php endforeach; ?>
                    </tbody>
                </table>
            </div>
        <?php endif; ?>
        <div class="border-t border-slate-800 px-5 py-3">
            <p class="mono text-[9px] uppercase tracking-[.12em] text-slate-600">All account actions require a valid session and CSRF token · your own admin account cannot be suspended or deleted</p>
        </div>
    </section>
</main>
</body>
</html>
