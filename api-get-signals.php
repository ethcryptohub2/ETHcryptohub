<?php
declare(strict_types=1);

require_once __DIR__ . '/auth-check.php';
requireUser(true);
session_write_close();

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Vary: Cookie');

function sendMarketResponse(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    exit;
}

function fetchCoinbaseTicker(string $product): array
{
    $url = 'https://api.exchange.coinbase.com/products/' . $product . '/ticker';
    $body = '';
    $status = 0;

    if (function_exists('curl_init')) {
        $handle = curl_init($url);
        if ($handle === false) {
            throw new RuntimeException('Unable to initialize the market data connection.');
        }

        $curlOptions = [
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT_MS => 2500,
            CURLOPT_TIMEOUT_MS => 6000,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HTTPHEADER => [
                'Accept: application/json',
                'User-Agent: ETHcryptohub-MarketData/1.0',
            ],
            CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$body): int {
                if (strlen($body) + strlen($chunk) > 32768) {
                    return 0;
                }
                $body .= $chunk;
                return strlen($chunk);
            },
        ];
        if (defined('CURLSSLOPT_NATIVE_CA')) {
            $curlOptions[CURLOPT_SSL_OPTIONS] = CURLSSLOPT_NATIVE_CA;
        }
        curl_setopt_array($handle, $curlOptions);

        $success = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $curlError = curl_error($handle);
        curl_close($handle);

        if ($success === false) {
            throw new RuntimeException('Market data connection failed: ' . $curlError);
        }
    } else {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'header' => "Accept: application/json\r\nUser-Agent: ETHcryptohub-MarketData/1.0\r\n",
                'timeout' => 6,
                'ignore_errors' => true,
                'follow_location' => 0,
                'max_redirects' => 0,
            ],
            'ssl' => [
                'verify_peer' => true,
                'verify_peer_name' => true,
            ],
        ]);
        $stream = @fopen($url, 'rb', false, $context);
        if ($stream === false) {
            throw new RuntimeException('Market data connection failed.');
        }

        try {
            $body = stream_get_contents($stream, 32769);
            $responseHeaders = $http_response_header ?? [];
        } finally {
            fclose($stream);
        }
        if (!is_string($body) || strlen($body) > 32768) {
            throw new RuntimeException('The market data response exceeded the size limit.');
        }
        foreach ($responseHeaders as $responseHeader) {
            if (preg_match('/^HTTP\/\S+\s+(\d{3})\b/', $responseHeader, $matches) === 1) {
                $status = (int) $matches[1];
            }
        }
    }

    if ($status !== 200) {
        throw new RuntimeException('Market data provider returned HTTP ' . $status . '.');
    }

    try {
        $ticker = json_decode($body, true, 16, JSON_THROW_ON_ERROR);
    } catch (JsonException $exception) {
        throw new RuntimeException('Market data provider returned invalid JSON.', 0, $exception);
    }

    if (!is_array($ticker)) {
        throw new RuntimeException('Market data provider returned an invalid ticker.');
    }

    $price = filter_var($ticker['price'] ?? null, FILTER_VALIDATE_FLOAT);
    $bid = filter_var($ticker['bid'] ?? null, FILTER_VALIDATE_FLOAT);
    $ask = filter_var($ticker['ask'] ?? null, FILTER_VALIDATE_FLOAT);
    $volume = filter_var($ticker['volume'] ?? null, FILTER_VALIDATE_FLOAT);
    $observedAt = $ticker['time'] ?? null;

    if ($price === false || $bid === false || $ask === false || $volume === false
        || !is_finite((float) $price) || !is_finite((float) $bid) || !is_finite((float) $ask)
        || !is_finite((float) $volume) || (float) $price <= 0 || (float) $bid <= 0
        || (float) $ask < (float) $bid || (float) $volume < 0
        || !is_string($observedAt) || strtotime($observedAt) === false) {
        throw new RuntimeException('Market data provider returned incomplete ticker fields.');
    }

    $mid = ((float) $bid + (float) $ask) / 2;
    $spreadBps = $mid > 0 ? (((float) $ask - (float) $bid) / $mid) * 10000 : 0;

    return [
        'price' => (float) $price,
        'bid' => (float) $bid,
        'ask' => (float) $ask,
        'volume_24h' => (float) $volume,
        'spread_bps' => round($spreadBps, 4),
        'spread_state' => $spreadBps >= 5 ? 'wide' : 'normal',
        'observed_at' => gmdate(DATE_ATOM, strtotime($observedAt)),
    ];
}

function validMarketCache(mixed $cache): bool
{
    if (!is_array($cache)) {
        return false;
    }

    if (!isset($cache['cached_at'], $cache['markets'])
        || !is_int($cache['cached_at'])
        || $cache['cached_at'] > time()
        || !is_array($cache['markets'])) {
        return false;
    }

    foreach (['BTC-USD', 'ETH-USD'] as $pair) {
        $market = $cache['markets'][$pair] ?? null;
        if (!is_array($market)
            || !isset($market['price'], $market['bid'], $market['ask'], $market['volume_24h'], $market['spread_bps'], $market['spread_state'], $market['observed_at'])
            || !is_numeric($market['price'])
            || !is_numeric($market['bid'])
            || !is_numeric($market['ask'])
            || !is_numeric($market['volume_24h'])
            || !is_numeric($market['spread_bps'])
            || !in_array($market['spread_state'], ['normal', 'wide'], true)
            || !is_string($market['observed_at'])) {
            return false;
        }
        foreach (['price', 'bid', 'ask', 'volume_24h', 'spread_bps'] as $field) {
            if (!is_finite((float) $market[$field])) {
                return false;
            }
        }
        if ((float) $market['price'] <= 0 || (float) $market['bid'] <= 0
            || (float) $market['ask'] < (float) $market['bid']
            || (float) $market['volume_24h'] < 0 || (float) $market['spread_bps'] < 0
            || strtotime($market['observed_at']) === false) {
            return false;
        }
    }

    return true;
}

function marketResponse(array $cache, bool $stale): array
{
    $signals = [];
    foreach ($cache['markets'] as $pair => $market) {
        $signals[] = [
            'pair' => $pair,
            'type' => 'quote_spread_monitor',
            'state' => $market['spread_state'],
            'spread_bps' => $market['spread_bps'],
        ];
    }

    return [
        'ok' => true,
        'provider' => 'Coinbase Exchange',
        'source' => 'https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker',
        'fetched_at' => gmdate(DATE_ATOM, $cache['cached_at']),
        'stale' => $stale,
        'markets' => $cache['markets'],
        'signals' => $signals,
        'notice' => 'Public ticker data and quote-spread monitoring only; this endpoint does not generate trade recommendations.',
    ];
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    header('Allow: GET');
    sendMarketResponse(405, ['ok' => false, 'error' => 'Method not allowed.']);
}

$cacheDirectory = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR)
    . DIRECTORY_SEPARATOR
    . 'ethcryptohub-market-' . hash('sha256', __DIR__);
if (!is_dir($cacheDirectory) && !@mkdir($cacheDirectory, 0700) && !is_dir($cacheDirectory)) {
    error_log('ETHcryptohub private market cache directory could not be created.');
    sendMarketResponse(503, ['ok' => false, 'error' => 'Market data is temporarily unavailable.']);
}
$cachePermissions = fileperms($cacheDirectory);
if (is_link($cacheDirectory) || !is_writable($cacheDirectory)
    || (DIRECTORY_SEPARATOR !== '\\' && ($cachePermissions === false || ($cachePermissions & 0077) !== 0))) {
    error_log('ETHcryptohub private market cache directory is not safely accessible.');
    sendMarketResponse(503, ['ok' => false, 'error' => 'Market data is temporarily unavailable.']);
}

$cachePath = $cacheDirectory . DIRECTORY_SEPARATOR . 'tickers.json';
if (is_link($cachePath)) {
    error_log('ETHcryptohub market cache path must not be a symbolic link.');
    sendMarketResponse(503, ['ok' => false, 'error' => 'Market data is temporarily unavailable.']);
}
$cacheFile = fopen($cachePath, 'c+');
if ($cacheFile === false) {
    error_log('ETHcryptohub market cache could not be opened.');
    sendMarketResponse(503, ['ok' => false, 'error' => 'Market data is temporarily unavailable.']);
}

$responseStatus = 503;
$responseBody = ['ok' => false, 'error' => 'Market data is temporarily unavailable.'];
$locked = false;

try {
    if (!flock($cacheFile, LOCK_EX)) {
        throw new RuntimeException('Unable to lock the market data cache.');
    }
    $locked = true;

    rewind($cacheFile);
    $cachedJson = stream_get_contents($cacheFile, 65537);
    if (!is_string($cachedJson) || strlen($cachedJson) > 65536) {
        $cachedJson = '';
    }

    $cached = null;
    if ($cachedJson !== '') {
        try {
            $decoded = json_decode($cachedJson, true, 16, JSON_THROW_ON_ERROR);
            if (validMarketCache($decoded)) {
                $cached = $decoded;
            }
        } catch (JsonException) {
            $cached = null;
        }
    }

    if ($cached !== null && time() - $cached['cached_at'] < 15) {
        $responseStatus = 200;
        $responseBody = marketResponse($cached, false);
    } else {
        try {
            $marketData = [
                'BTC-USD' => fetchCoinbaseTicker('BTC-USD'),
                'ETH-USD' => fetchCoinbaseTicker('ETH-USD'),
            ];
            $freshCache = ['cached_at' => time(), 'markets' => $marketData];
            $encodedCache = json_encode($freshCache, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);

            rewind($cacheFile);
            if (!ftruncate($cacheFile, 0) || fwrite($cacheFile, $encodedCache) !== strlen($encodedCache) || !fflush($cacheFile)) {
                throw new RuntimeException('Unable to save the market data cache.');
            }

            $responseStatus = 200;
            $responseBody = marketResponse($freshCache, false);
        } catch (RuntimeException | JsonException $exception) {
            error_log('ETHcryptohub market data upstream error: ' . $exception->getMessage());
            if ($cached !== null && time() - $cached['cached_at'] <= 120) {
                $responseStatus = 200;
                $responseBody = marketResponse($cached, true);
            } else {
                $responseStatus = 502;
                $responseBody = [
                    'ok' => false,
                    'error' => 'The market data provider is temporarily unavailable.',
                ];
            }
        }
    }
} catch (RuntimeException $exception) {
    error_log('ETHcryptohub market data cache error: ' . $exception->getMessage());
    $responseStatus = 503;
    $responseBody = ['ok' => false, 'error' => 'Market data is temporarily unavailable.'];
} finally {
    if ($locked) {
        flock($cacheFile, LOCK_UN);
    }
    fclose($cacheFile);
}

sendMarketResponse($responseStatus, $responseBody);
