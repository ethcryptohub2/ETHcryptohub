<?php
declare(strict_types=1);

require_once __DIR__ . '/auth-check.php';
$user = requireUser();
$signals = [
    ['time' => date('H:i:s'), 'pair' => 'ETH/USDT', 'action' => 'LONG', 'leverage' => '3×', 'confidence' => 82],
    ['time' => date('H:i:s', time() - 42), 'pair' => 'BTC/USDT', 'action' => 'SHORT', 'leverage' => '2×', 'confidence' => 74],
    ['time' => date('H:i:s', time() - 118), 'pair' => 'SOL/USDT', 'action' => 'LONG', 'leverage' => '2×', 'confidence' => 91],
    ['time' => date('H:i:s', time() - 205), 'pair' => 'ETH/USDT', 'action' => 'LONG', 'leverage' => '3×', 'confidence' => 68],
];
?>
<!doctype html>
<html lang="en" class="dark">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#07090e">
    <title>Trading terminal | ETHcryptohub</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>body{font-family:'Space Grotesk',sans-serif;background:#07090e}.mono{font-family:'DM Mono',monospace}</style>
</head>
<body class="min-h-screen bg-[#07090e] text-slate-100 antialiased">
<header class="sticky top-0 z-20 border-b border-slate-800/80 bg-[#07090e]/90 backdrop-blur-xl">
    <nav class="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8" aria-label="User navigation">
        <a href="index.php" class="flex shrink-0 items-center gap-3">
            <span class="grid size-9 place-items-center rounded-xl border border-cyan-400/15 bg-cyan-400/[0.07] text-lg text-cyan-300">Ξ</span>
            <span class="text-sm font-semibold tracking-tight">ETH<span class="text-cyan-300">crypto</span>hub <span class="ml-1 hidden text-[9px] font-medium uppercase tracking-[.18em] text-slate-500 sm:inline">Terminal</span></span>
        </a>
        <div class="order-3 flex basis-full min-w-0 items-center gap-2 text-xs text-slate-400 md:order-none md:basis-auto">
            <span class="size-1.5 rounded-full bg-emerald-400"></span>
            <span class="truncate"><?= e($user['email']) ?></span>
            <span class="mx-1 text-slate-700">/</span>
            <?php if ((int) $user['is_x_verified'] === 1): ?>
                <span class="rounded-full border border-emerald-400/20 bg-emerald-400/[0.07] px-2.5 py-1 text-[10px] text-emerald-300">X verified</span>
            <?php else: ?>
                <span class="rounded-full border border-amber-400/20 bg-amber-400/[0.06] px-2.5 py-1 text-[10px] text-amber-300">X pending</span>
            <?php endif; ?>
        </div>
        <div class="flex shrink-0 items-center gap-2 sm:gap-4">
            <a href="smartexit.php" class="rounded-lg border border-emerald-400/20 bg-emerald-400/[0.05] px-2 py-2 text-[10px] font-medium text-emerald-300 transition hover:bg-emerald-400/[0.1] sm:px-3 sm:text-xs">SmartExit</a>
            <?php if ($user['role'] === 'admin'): ?>
                <a href="admin/dashboard.php" class="rounded-lg border border-cyan-400/20 px-2 py-2 text-[10px] font-medium text-cyan-300 transition hover:bg-cyan-400/[0.06] sm:px-3 sm:text-xs"><span class="sm:hidden">Admin</span><span class="hidden sm:inline">Admin panel</span></a>
            <?php endif; ?>
            <a href="settings.php" class="rounded-lg px-2 py-2 text-xs text-slate-300 transition hover:bg-white/[0.04] hover:text-white sm:px-3">Settings</a>
            <a href="binance-settings.php" class="rounded-lg px-2 py-2 text-xs text-slate-300 transition hover:bg-white/[0.04] hover:text-white sm:px-3">Binance API</a>
            <form method="post" action="logout.php">
                <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
                <button type="submit" class="rounded-lg border border-slate-800 px-3 py-2 text-xs text-slate-400 transition hover:border-rose-400/25 hover:text-rose-300">Sign out</button>
            </form>
        </div>
    </nav>
</header>

<main class="mx-auto max-w-[1600px] px-4 py-7 sm:px-6 lg:px-8">
    <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
            <p class="mono text-[10px] uppercase tracking-[.2em] text-cyan-300/70">Market operations · mainnet</p>
            <h1 class="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Trading terminal</h1>
        </div>
        <div class="mono flex items-center gap-2 rounded-full border border-emerald-400/15 bg-emerald-400/[0.045] px-3 py-2 text-[10px] text-emerald-300">
            <span class="size-1.5 rounded-full bg-emerald-400"></span> CONNECTED · <time id="terminal-clock"><?= e(gmdate('H:i:s')) ?> UTC</time>
        </div>
    </div>

    <section aria-label="Market metrics" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article class="rounded-2xl border border-slate-800 bg-[#0f1420] p-5">
            <div class="flex items-center justify-between"><p class="mono text-[10px] uppercase tracking-[.14em] text-slate-500">BTC / USD</p><span class="rounded-md border border-emerald-400/15 bg-emerald-400/[0.04] px-2 py-1 text-[9px] text-emerald-300">LIVE SNAPSHOT</span></div>
            <div class="mt-4 flex items-end justify-between gap-2"><p id="btc-price" class="text-2xl font-medium tracking-tight tabular-nums">Connecting…</p><span id="btc-spread" class="mono text-right text-[10px] text-slate-400">— bps</span></div>
            <p id="btc-market-status" class="mono mt-2 text-[10px] text-slate-600">Coinbase Exchange · loading quote</p>
        </article>
        <article class="rounded-2xl border border-slate-800 bg-[#0f1420] p-5">
            <div class="flex items-center justify-between"><p class="mono text-[10px] uppercase tracking-[.14em] text-slate-500">ETH / USD</p><span class="rounded-md border border-emerald-400/15 bg-emerald-400/[0.04] px-2 py-1 text-[9px] text-emerald-300">LIVE SNAPSHOT</span></div>
            <div class="mt-4 flex items-end justify-between gap-2"><p id="eth-price" class="text-2xl font-medium tracking-tight tabular-nums">Connecting…</p><span id="eth-spread" class="mono text-right text-[10px] text-slate-400">— bps</span></div>
            <p id="eth-market-status" class="mono mt-2 text-[10px] text-slate-600">Coinbase Exchange · loading quote</p>
        </article>
        <article class="rounded-2xl border border-slate-800 bg-[#0f1420] p-5">
            <div class="flex items-center justify-between"><p class="mono text-[10px] uppercase tracking-[.14em] text-slate-500">AI trade engine</p><span class="size-1.5 rounded-full bg-emerald-400"></span></div>
            <p class="mt-4 text-lg font-medium text-slate-100">Scanning 15m candles</p>
            <p class="mono mt-2 text-[10px] text-slate-600">SIMULATED ENGINE STATUS</p>
        </article>
        <article class="rounded-2xl border border-slate-800 bg-[#0f1420] p-5">
            <div class="flex items-center justify-between"><p class="mono text-[10px] uppercase tracking-[.14em] text-slate-500">Quote-spread monitor</p><span id="spread-monitor-badge" class="rounded-md border border-slate-700 px-2 py-1 text-[9px] text-slate-400">CONNECTING</span></div>
            <p id="spread-monitor-state" class="mt-4 text-lg font-medium text-slate-100">Loading market quotes</p>
            <p id="spread-monitor-detail" class="mono mt-2 text-[10px] text-slate-600">COINBASE EXCHANGE · SPREAD ONLY</p>
        </article>
    </section>

    <section class="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,.75fr)]">
        <div class="space-y-5">
            <article class="overflow-hidden rounded-2xl border border-slate-800 bg-[#0f1420]">
                <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
                    <div><h2 class="text-sm font-semibold">Agent signal stream</h2><p class="mt-1 text-xs text-slate-500">Illustrative signal log · not live execution advice</p></div>
                    <span class="mono rounded-md border border-slate-700 px-2.5 py-1.5 text-[9px] text-slate-500">SIMULATED FEED</span>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full min-w-[650px] text-left text-xs">
                        <thead class="mono border-b border-slate-800/80 text-[9px] uppercase tracking-[.13em] text-slate-500">
                        <tr><th class="px-5 py-3 font-normal">Timestamp</th><th class="px-4 py-3 font-normal">Pair</th><th class="px-4 py-3 font-normal">Action</th><th class="px-4 py-3 font-normal">Leverage</th><th class="px-4 py-3 font-normal">Confidence</th><th class="px-5 py-3 font-normal">Signal</th></tr>
                        </thead>
                        <tbody class="divide-y divide-slate-800/70">
                        <?php foreach ($signals as $signal): ?>
                            <tr class="transition hover:bg-white/[0.02]">
                                <td class="mono px-5 py-4 text-[10px] text-slate-500"><?= e($signal['time']) ?></td>
                                <td class="mono px-4 py-4 text-slate-300"><?= e($signal['pair']) ?></td>
                                <td class="px-4 py-4"><span class="rounded-md border px-2 py-1 text-[9px] font-medium <?= $signal['action'] === 'LONG' ? 'border-emerald-400/15 bg-emerald-400/[0.055] text-emerald-300' : 'border-rose-400/15 bg-rose-400/[0.055] text-rose-300' ?>"><?= e($signal['action']) ?></span></td>
                                <td class="mono px-4 py-4 text-slate-400"><?= e($signal['leverage']) ?></td>
                                <td class="mono px-4 py-4 text-slate-300"><?= e($signal['confidence']) ?>%</td>
                                <td class="px-5 py-4"><span class="flex items-center gap-2 text-[10px] text-slate-400"><span class="size-1.5 rounded-full <?= $signal['action'] === 'LONG' ? 'bg-emerald-400' : 'bg-rose-400' ?>"></span>Model signal</span></td>
                            </tr>
                        <?php endforeach; ?>
                        </tbody>
                    </table>
                </div>
                <div class="flex items-center justify-between border-t border-slate-800 px-5 py-3">
                    <span class="mono text-[9px] text-slate-600">SAMPLE DATA · NO ORDERS ARE PLACED</span>
                    <span class="mono text-[9px] text-slate-500">4 SIGNALS</span>
                </div>
            </article>

            <article class="overflow-hidden rounded-2xl border border-slate-800 bg-[#0f1420]">
                <div class="flex items-center justify-between border-b border-slate-800 px-5 py-4">
                    <div><h2 class="text-sm font-semibold">Order book depth</h2><p class="mt-1 text-xs text-slate-500">BTC / USD · illustrative sample levels</p></div>
                    <span class="mono text-[9px] text-slate-500">SAMPLE</span>
                </div>
                <div class="grid grid-cols-2 gap-6 p-5">
                    <div>
                        <div class="mono mb-3 flex justify-between text-[9px] uppercase tracking-wider text-emerald-400"><span>Bid size</span><span>Price (USD)</span></div>
                        <?php foreach ([['0.842', '67,481.20', '66%'], ['1.204', '67,478.50', '83%'], ['0.518', '67,472.00', '45%']] as [$size, $price, $width]): ?>
                            <div class="relative mb-2 flex justify-between overflow-hidden rounded-md px-2.5 py-2">
                                <span class="absolute inset-y-0 right-0 bg-emerald-400/[0.06]" style="width:<?= e($width) ?>"></span>
                                <span class="mono relative text-[10px] text-slate-400"><?= e($size) ?></span><span class="mono relative text-[10px] text-emerald-300"><?= e($price) ?></span>
                            </div>
                        <?php endforeach; ?>
                    </div>
                    <div>
                        <div class="mono mb-3 flex justify-between text-[9px] uppercase tracking-wider text-rose-400"><span>Ask size</span><span>Price (USD)</span></div>
                        <?php foreach ([['0.621', '67,486.40', '52%'], ['1.018', '67,491.80', '78%'], ['0.394', '67,498.20', '37%']] as [$size, $price, $width]): ?>
                            <div class="relative mb-2 flex justify-between overflow-hidden rounded-md px-2.5 py-2">
                                <span class="absolute inset-y-0 right-0 bg-rose-400/[0.06]" style="width:<?= e($width) ?>"></span>
                                <span class="mono relative text-[10px] text-slate-400"><?= e($size) ?></span><span class="mono relative text-[10px] text-rose-300"><?= e($price) ?></span>
                            </div>
                        <?php endforeach; ?>
                    </div>
                </div>
            </article>
        </div>

        <aside class="space-y-5">
            <article class="rounded-2xl border border-slate-800 bg-[#0f1420] p-5">
                <div class="flex items-center justify-between">
                    <div><h2 class="text-sm font-semibold">Account snapshot</h2><p class="mt-1 text-xs text-slate-500">Verified account profile</p></div>
                    <span class="grid size-10 place-items-center rounded-xl border border-cyan-400/15 bg-cyan-400/[0.06] text-sm font-medium text-cyan-300"><?= e(strtoupper(substr((string) $user['email'], 0, 1))) ?></span>
                </div>
                <dl class="mt-5 divide-y divide-slate-800/80">
                    <div class="flex items-start justify-between gap-4 py-3"><dt class="text-xs text-slate-500">Email</dt><dd class="max-w-[65%] break-all text-right text-xs text-slate-200"><?= e($user['email']) ?></dd></div>
                    <div class="flex items-start justify-between gap-4 py-3"><dt class="text-xs text-slate-500">Phone</dt><dd class="text-right text-xs text-slate-200"><?= $user['phone_number'] !== null ? e($user['country_code'] . ' ' . $user['phone_number']) : '—' ?></dd></div>
                    <div class="flex items-start justify-between gap-4 py-3"><dt class="text-xs text-slate-500">X handle</dt><dd class="text-right text-xs text-slate-200"><?= $user['x_handle'] !== null ? '@' . e($user['x_handle']) : 'Not connected' ?></dd></div>
                    <div class="flex items-center justify-between gap-4 py-3"><dt class="text-xs text-slate-500">X verification</dt><dd><?php if ((int) $user['is_x_verified'] === 1): ?><span class="rounded-full border border-emerald-400/15 bg-emerald-400/[0.05] px-2.5 py-1 text-[10px] text-emerald-300">Verified</span><?php else: ?><span class="rounded-full border border-amber-400/15 bg-amber-400/[0.05] px-2.5 py-1 text-[10px] text-amber-300">Pending</span><?php endif; ?></dd></div>
                    <div class="flex items-center justify-between gap-4 py-3"><dt class="text-xs text-slate-500">Email status</dt><dd><span class="text-[10px] text-emerald-300">Verified</span></dd></div>
                </dl>
                <a href="settings.php" class="mt-3 inline-flex w-full items-center justify-center rounded-xl border border-slate-700 py-2.5 text-xs font-medium text-slate-300 transition hover:border-cyan-400/30 hover:text-cyan-200">Manage profile <span class="ml-2">↗</span></a>
            </article>
            <article class="rounded-2xl border border-slate-800 bg-[#0f1420] p-5">
                <div class="flex items-center justify-between"><h2 class="text-sm font-semibold">System activity</h2><span class="flex items-center gap-2 text-[10px] text-emerald-300"><span class="size-1.5 rounded-full bg-emerald-400"></span>Nominal</span></div>
                <div class="mt-4 space-y-4">
                    <div class="flex gap-3"><span class="mt-1 size-1.5 shrink-0 rounded-full bg-emerald-400"></span><div><p class="text-xs text-slate-300">Market data channel connected</p><p class="mono mt-1 text-[9px] text-slate-600">SAMPLE STATUS · LOW LATENCY</p></div></div>
                    <div class="flex gap-3"><span class="mt-1 size-1.5 shrink-0 rounded-full bg-cyan-400"></span><div><p class="text-xs text-slate-300">Signal engine scanning 15m candles</p><p class="mono mt-1 text-[9px] text-slate-600">SIMULATED ACTIVITY</p></div></div>
                    <div class="flex gap-3"><span class="mt-1 size-1.5 shrink-0 rounded-full bg-amber-400"></span><div><p class="text-xs text-slate-300">Liquidity contraction watch enabled</p><p class="mono mt-1 text-[9px] text-slate-600">SAMPLE ALERT</p></div></div>
                </div>
            </article>
        </aside>
    </section>
    <footer class="mt-8 border-t border-slate-800/80 py-5 text-center">
        <p class="mono text-[9px] uppercase tracking-[.15em] text-slate-600">Simulated dashboard data · not investment advice · no live trading actions are performed</p>
    </footer>
</main>
<script>
    (() => {
        const clock = document.getElementById('terminal-clock');
        const formatUsd = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2});
        let lastUserInteraction = Date.now();

        for (const eventName of ['pointerdown', 'keydown', 'touchstart', 'scroll']) {
            document.addEventListener(eventName, () => { lastUserInteraction = Date.now(); }, {passive: true});
        }

        if (clock) {
            window.setInterval(() => { clock.textContent = new Date().toISOString().slice(11, 19) + ' UTC'; }, 1000);
        }

        const setUnavailable = (message) => {
            for (const id of ['btc-price', 'eth-price']) {
                const element = document.getElementById(id);
                if (element) element.textContent = 'Unavailable';
            }
            for (const id of ['btc-market-status', 'eth-market-status']) {
                const element = document.getElementById(id);
                if (element) element.textContent = message;
            }
            const badge = document.getElementById('spread-monitor-badge');
            const state = document.getElementById('spread-monitor-state');
            const detail = document.getElementById('spread-monitor-detail');
            if (badge) badge.textContent = 'OFFLINE';
            if (state) state.textContent = 'Market data unavailable';
            if (detail) detail.textContent = 'RETRYING · NO SIGNALS GENERATED';
        };

        const refreshMarketData = async () => {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), 9000);
            try {
                const response = await fetch('api-get-signals.php', {
                    method: 'GET',
                    credentials: 'same-origin',
                    cache: 'no-store',
                    headers: {
                        'Accept': 'application/json',
                        'X-User-Active': Date.now() - lastUserInteraction < 20000 ? '1' : '0'
                    },
                    signal: controller.signal
                });
                const payload = await response.json();
                if (response.status === 401) {
                    setUnavailable('Session expired · sign in again');
                    window.setTimeout(() => { window.location.assign('login.php'); }, 1200);
                    return;
                }
                if (!response.ok || payload.ok !== true || !payload.markets) {
                    throw new Error('Market data request failed.');
                }

                for (const [symbol, prefix] of [['BTC-USD', 'btc'], ['ETH-USD', 'eth']]) {
                    const market = payload.markets[symbol];
                    if (!market || !Number.isFinite(Number(market.price)) || !Number.isFinite(Number(market.spread_bps))) {
                        throw new Error('Market data response was incomplete.');
                    }
                    const price = document.getElementById(prefix + '-price');
                    const spread = document.getElementById(prefix + '-spread');
                    const status = document.getElementById(prefix + '-market-status');
                    if (price) price.textContent = formatUsd.format(Number(market.price));
                    if (spread) spread.textContent = Number(market.spread_bps).toFixed(2) + ' bps';
                    if (status) {
                        status.textContent = (payload.stale ? 'STALE · ' : 'Coinbase Exchange · ')
                            + 'bid ' + formatUsd.format(Number(market.bid))
                            + ' / ask ' + formatUsd.format(Number(market.ask));
                    }
                }

                const wide = Object.values(payload.markets).some((market) => market.spread_state === 'wide');
                const badge = document.getElementById('spread-monitor-badge');
                const state = document.getElementById('spread-monitor-state');
                const detail = document.getElementById('spread-monitor-detail');
                if (badge) {
                    badge.textContent = payload.stale ? 'STALE DATA' : (wide ? 'WIDE SPREAD' : 'NORMAL');
                    badge.className = 'rounded-md border px-2 py-1 text-[9px] ' + (payload.stale || wide
                        ? 'border-amber-400/15 bg-amber-400/[0.045] text-amber-300'
                        : 'border-emerald-400/15 bg-emerald-400/[0.045] text-emerald-300');
                }
                if (state) state.textContent = wide ? 'Wide quote spread' : 'Quote spread normal';
                if (detail) detail.textContent = payload.stale
                    ? 'CACHED QUOTE · UPSTREAM RETRYING'
                    : 'COINBASE EXCHANGE · QUOTE-SPREAD MONITOR';
            } catch (error) {
                setUnavailable(error.name === 'AbortError' ? 'Market data request timed out' : 'Market data feed unavailable');
            } finally {
                window.clearTimeout(timeout);
            }
        };

        refreshMarketData();
        window.setInterval(refreshMarketData, 20000);
    })();
</script>
</body>
</html>
