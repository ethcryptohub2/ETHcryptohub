<?php
declare(strict_types=1);

require_once __DIR__ . '/auth-check.php';
requireUser();

$shellPath = __DIR__ . '/smartexit/apps/web/dist/index.html';
if (!is_file($shellPath) || !is_readable($shellPath)) {
    http_response_code(503);
    exit('SmartExit is not built yet. Run npm ci and npm run build in the smartexit directory.');
}

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store, private');
header('X-Content-Type-Options: nosniff');
readfile($shellPath);
