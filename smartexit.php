<?php
declare(strict_types=1);

require_once __DIR__ . '/auth-check.php';
$user = requireUser();
$manifestPath = __DIR__ . '/smartexit/apps/web/dist/.vite/manifest.json';

if (!is_file($manifestPath)) {
    http_response_code(503);
    exit('SmartExit is not built yet. Run npm ci and npm run build in the smartexit directory.');
}

try {
    $manifest = json_decode((string) file_get_contents($manifestPath), true, 512, JSON_THROW_ON_ERROR);
    $entry = $manifest['index.html'] ?? $manifest['src/main.tsx'] ?? null;
    if (!is_array($entry) || !isset($entry['file']) || !is_string($entry['file'])) {
        throw new RuntimeException('SmartExit frontend entry is missing from its build manifest.');
    }
    $stylesheets = isset($entry['css']) && is_array($entry['css']) ? $entry['css'] : [];
} catch (JsonException | RuntimeException $exception) {
    error_log('ETHcryptohub SmartExit frontend error: ' . $exception->getMessage());
    http_response_code(503);
    exit('SmartExit frontend is temporarily unavailable.');
}

$assetBase = '/smartexit/apps/web/dist/';
?>
<!doctype html>
<html lang="en" class="dark">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#07090e">
    <meta name="csrf-token" content="<?= e(csrf_token()) ?>">
    <meta name="description" content="SmartExit paper trade intents and risk dashboard.">
    <title>SmartExit paper terminal | ETHcryptohub</title>
    <?php foreach ($stylesheets as $stylesheet): ?>
        <?php if (is_string($stylesheet)): ?>
            <link rel="stylesheet" href="<?= e($assetBase . ltrim($stylesheet, '/')) ?>">
        <?php endif; ?>
    <?php endforeach; ?>
    <script>
        window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    </script>
    <script defer src="/_vercel/insights/script.js"></script>
</head>
<body>
<div id="root"></div>
<form id="ethcryptohub-logout-form" method="post" action="logout.php" hidden>
    <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
</form>
<script type="module" src="<?= e($assetBase . $entry['file']) ?>"></script>
</body>
</html>
