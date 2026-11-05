<?php
declare(strict_types=1);

require_once __DIR__ . '/auth-check.php';
$user = requireUser(true);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if (!in_array($method, ['GET', 'POST', 'PUT'], true)) {
    header('Allow: GET, POST, PUT');
    http_response_code(405);
    echo json_encode(['error' => ['code' => 'METHOD_NOT_ALLOWED', 'message' => 'This request method is not supported.']]);
    exit;
}

if ($method === 'GET' && ($_GET['csrf'] ?? null) === '1') {
    echo json_encode(['data' => ['csrfToken' => csrf_token()]]);
    exit;
}

$targetValue = $_GET['path'] ?? null;
if (!is_string($targetValue) || strlen($targetValue) > 2048) {
    http_response_code(400);
    echo json_encode(['error' => ['code' => 'INVALID_API_PATH', 'message' => 'The SmartExit API path is invalid.']]);
    exit;
}

$targetParts = parse_url($targetValue);
$targetPath = is_array($targetParts) ? ($targetParts['path'] ?? '') : '';
$targetQuery = is_array($targetParts) ? ($targetParts['query'] ?? '') : '';
$pathValid = is_string($targetPath)
    && preg_match('#^/api/[A-Za-z0-9._/-]*$#D', $targetPath) === 1
    && !preg_match('~(?:^|/)\.\.(?:/|$)~', $targetPath);
$queryValid = is_string($targetQuery)
    && preg_match('#^[A-Za-z0-9._~!$&\'()*+,;=:@/?%-]*$#D', $targetQuery) === 1
    && preg_match('/%(?![A-Fa-f0-9]{2})/', $targetQuery) !== 1;
$forbiddenTargetParts = is_array($targetParts)
    ? array_intersect(['scheme', 'host', 'user', 'pass', 'fragment'], array_keys($targetParts))
    : ['invalid'];
if (!$pathValid || !$queryValid || $forbiddenTargetParts !== []) {
    http_response_code(400);
    echo json_encode(['error' => ['code' => 'INVALID_API_PATH', 'message' => 'The SmartExit API path is invalid.']]);
    exit;
}
$target = $targetPath . ($targetQuery !== '' ? '?' . $targetQuery : '');

if ($method !== 'GET') {
    $csrfToken = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null;
    if (!is_string($csrfToken) || !verify_csrf_token($csrfToken)) {
        http_response_code(403);
        echo json_encode(['error' => ['code' => 'CSRF_VALIDATION_FAILED', 'message' => 'Refresh the page and try again.']]);
        exit;
    }
}

$contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($contentLength > 32768) {
    http_response_code(413);
    echo json_encode(['error' => ['code' => 'REQUEST_TOO_LARGE', 'message' => 'The SmartExit request is too large.']]);
    exit;
}
$body = file_get_contents('php://input');
if ($body === false) {
    http_response_code(400);
    echo json_encode(['error' => ['code' => 'REQUEST_BODY_UNAVAILABLE', 'message' => 'The request could not be read.']]);
    exit;
}

$secret = getenv('SMARTEXIT_BRIDGE_SECRET') ?: '';
if ($secret === '' && isLoopbackRequest()) {
    $localDataDirectory = trim((string) (getenv('LOCALAPPDATA') ?: ''));
    if ($localDataDirectory !== '') {
        $localSecretPath = $localDataDirectory . DIRECTORY_SEPARATOR
            . 'ETHcryptohub' . DIRECTORY_SEPARATOR . 'smartexit-bridge.secret';
        if (is_file($localSecretPath) && is_readable($localSecretPath)) {
            $localSecret = file_get_contents($localSecretPath);
            $secret = is_string($localSecret) ? trim($localSecret) : '';
        }
    }
}
if (strlen($secret) < 32) {
    error_log('ETHcryptohub SmartExit bridge is unavailable: SMARTEXIT_BRIDGE_SECRET must contain at least 32 characters.');
    http_response_code(503);
    echo json_encode(['error' => ['code' => 'SMARTEXIT_UNAVAILABLE', 'message' => 'SmartExit is not configured on this server yet.']]);
    exit;
}

$apiBase = getenv('SMARTEXIT_API_URL') ?: 'http://127.0.0.1:3001';
$apiParts = parse_url($apiBase);
$apiHost = is_array($apiParts) ? strtolower((string) ($apiParts['host'] ?? '')) : '';
$apiScheme = is_array($apiParts) ? ($apiParts['scheme'] ?? '') : '';
$isLoopbackApi = in_array($apiHost, ['127.0.0.1', 'localhost', '::1'], true);
$isRailwayPrivateApi = preg_match(
    '/\A[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.railway\.internal\z/i',
    $apiHost
) === 1;
$apiPort = is_array($apiParts) ? ($apiParts['port'] ?? null) : null;
$hasValidPort = $apiPort === null || ($apiPort >= 1 && $apiPort <= 65535);
if ((!$isLoopbackApi && !$isRailwayPrivateApi)
    || $apiScheme !== 'http'
    || !$hasValidPort
    || array_intersect(['user', 'pass', 'path', 'query', 'fragment'], array_keys($apiParts ?: [])) !== []) {
    error_log('ETHcryptohub SmartExit API URL must be a loopback or Railway private HTTP origin.');
    http_response_code(503);
    echo json_encode(['error' => ['code' => 'SMARTEXIT_UNAVAILABLE', 'message' => 'SmartExit is not configured on this server yet.']]);
    exit;
}

$userId = (string) $user['id'];
$timestamp = (string) time();
$signedMessage = $userId . "\n" . $timestamp . "\n" . $method . "\n" . $target;
$signature = hash_hmac('sha256', $signedMessage, $secret);
$headers = [
    'Accept: application/json',
    'X-Ethcryptohub-User: ' . $userId,
    'X-Ethcryptohub-Timestamp: ' . $timestamp,
    'X-Ethcryptohub-Signature: ' . $signature,
];
if ($method !== 'GET' && $body !== '') {
    $headers[] = 'Content-Type: application/json';
}

$context = stream_context_create([
    'http' => [
        'method' => $method,
        'header' => implode("\r\n", $headers),
        'content' => $body,
        'timeout' => 90,
        'ignore_errors' => true,
        'protocol_version' => 1.1,
    ],
]);
$apiUrl = rtrim($apiBase, '/') . $target;
$upstreamBody = file_get_contents($apiUrl, false, $context);
if ($upstreamBody === false) {
    $lastError = error_get_last();
    error_log('ETHcryptohub SmartExit API request failed: ' . ($lastError['message'] ?? 'unknown upstream error'));
    http_response_code(503);
    echo json_encode(['error' => ['code' => 'SMARTEXIT_UNAVAILABLE', 'message' => 'SmartExit is temporarily unavailable.']]);
    exit;
}

$statusCode = 502;
foreach ($http_response_header ?? [] as $responseHeader) {
    if (preg_match('/^HTTP\/\S+\s+([1-5][0-9]{2})\b/', $responseHeader, $matches) === 1) {
        $statusCode = (int) $matches[1];
    }
}
http_response_code($statusCode);
echo $upstreamBody;
