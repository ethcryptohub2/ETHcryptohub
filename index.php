<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

$isLoggedIn = isset($_SESSION['user_id']);
$serverTime = time();
?>
<!doctype html>
<html lang="en" class="dark">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#07090e">
    <meta name="description" content="ETHcryptohub is your secure gateway to crypto intelligence, execution tools, and Web3 identity.">
    <title>ETHcryptohub — Intelligence, in execution</title>
    <script>
        tailwind = {
            config: {
                theme: {
                    extend: {
                        colors: {
                            obsidian: '#07090e',
                            panel: '#0d111c',
                            emerald: { 400: '#10b981' },
                            ice: '#38bdf8'
                        },
                        fontFamily: {
                            sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif']
                        }
                    }
                }
            }
        };
    </script>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root { color-scheme: dark; }
        html { scroll-behavior: smooth; }
        body {
            background-color: #07090e;
            background-image:
                radial-gradient(ellipse at 50% 12%, rgba(56, 189, 248, .075), transparent 36rem),
                linear-gradient(rgba(148, 163, 184, .035) 1px, transparent 1px),
                linear-gradient(90deg, rgba(148, 163, 184, .035) 1px, transparent 1px);
            background-size: auto, 56px 56px, 56px 56px;
            font-family: 'Space Grotesk', ui-sans-serif, system-ui, sans-serif;
        }
        .mono { font-family: 'DM Mono', ui-monospace, monospace; }
        .glass { background: rgba(13, 17, 28, .76); backdrop-filter: blur(18px); }
        .hairline { border-color: rgba(255, 255, 255, .075); }
        .soft-glow { box-shadow: 0 0 80px rgba(56, 189, 248, .055); }
        .market-strip { scrollbar-width: none; }
        .market-strip::-webkit-scrollbar { display: none; }
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; }
        }
    </style>
    <script>
        window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    </script>
    <script defer src="/_vercel/insights/script.js"></script>
</head>
<body class="min-h-screen overflow-x-hidden text-slate-100 antialiased selection:bg-sky-400/30 selection:text-white">
<div class="pointer-events-none fixed inset-x-0 top-0 -z-10 h-[34rem] bg-[radial-gradient(ellipse_at_50%_0%,rgba(16,185,129,0.07),transparent_58%)]"></div>

<header class="sticky top-0 z-30 px-3 pt-3 sm:px-6 sm:pt-5">
    <nav aria-label="Main navigation" class="glass mx-auto flex max-w-7xl items-center justify-between rounded-2xl border hairline px-4 py-3 shadow-2xl shadow-black/20 sm:px-6">
        <a href="index.php" class="group flex items-center gap-3" aria-label="ETHcryptohub home">
            <span class="grid size-10 place-items-center rounded-xl border border-sky-300/15 bg-sky-300/[0.07] text-sky-300 transition group-hover:border-sky-300/30">
                <svg viewBox="0 0 32 32" class="size-6" fill="none" aria-hidden="true">
                    <path d="M16 3 6.5 16.2 16 21.8l9.5-5.6L16 3Z" fill="currentColor" fill-opacity=".92"/>
                    <path d="m6.5 18.3 9.5 10.1 9.5-10.1-9.5 5.6-9.5-5.6Z" fill="currentColor" fill-opacity=".55"/>
                </svg>
            </span>
            <span class="leading-none">
                <span class="block text-[15px] font-semibold tracking-[-.04em] text-white">ETH<span class="text-sky-300">crypto</span>hub</span>
                <span class="mt-1.5 block text-[9px] font-medium uppercase tracking-[.24em] text-slate-500">Intelligence terminal</span>
            </span>
        </a>

        <div class="hidden items-center gap-8 text-[13px] text-slate-400 md:flex">
            <a href="#architecture" class="transition hover:text-white">Platform</a>
            <a href="#market-snapshot" class="transition hover:text-white">Market snapshot</a>
            <a href="#architecture" class="transition hover:text-white">Directory</a>
        </div>

        <div class="flex items-center gap-2 sm:gap-3">
            <div class="hidden items-center gap-2 rounded-full border border-emerald-400/15 bg-emerald-400/[0.055] px-3 py-1.5 sm:flex">
                <span class="relative flex size-1.5">
                    <span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-40"></span>
                    <span class="relative inline-flex size-1.5 rounded-full bg-emerald-400"></span>
                </span>
                <span class="text-[10px] font-medium tracking-wide text-emerald-300">MAINNET SYNCED</span>
            </div>
            <?php if ($isLoggedIn): ?>
                <a href="dashboard.php" class="hidden rounded-full bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-sky-200 sm:inline-flex">
                    Launch terminal <span aria-hidden="true" class="ml-1.5">↗</span>
                </a>
                <details class="group relative">
                    <summary class="flex size-9 cursor-pointer list-none items-center justify-center rounded-full border hairline bg-white/[0.035] text-slate-300 transition hover:border-white/15 hover:text-white" aria-label="Open account menu">
                        <svg viewBox="0 0 20 20" class="size-4" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6.75 7a6.75 6.75 0 1 1 13.5 0H3.25Z" clip-rule="evenodd"/></svg>
                    </summary>
                    <div class="glass absolute right-0 mt-3 w-48 rounded-xl border hairline p-2 shadow-2xl">
                        <a href="dashboard.php" class="block rounded-lg px-3 py-2.5 text-sm text-slate-300 transition hover:bg-white/[0.05] hover:text-white">Trading terminal</a>
                        <a href="settings.php" class="block rounded-lg px-3 py-2.5 text-sm text-slate-300 transition hover:bg-white/[0.05] hover:text-white">Profile &amp; identity</a>
                        <div class="my-1 border-t hairline"></div>
                        <form method="post" action="logout.php">
                            <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
                            <button type="submit" class="w-full rounded-lg px-3 py-2.5 text-left text-sm text-slate-400 transition hover:bg-rose-400/[0.06] hover:text-rose-300">Sign out</button>
                        </form>
                    </div>
                </details>
                <a href="dashboard.php" class="grid size-9 place-items-center rounded-full bg-slate-100 text-slate-950 sm:hidden" aria-label="Launch terminal">
                    <svg viewBox="0 0 20 20" class="size-4" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 10h12M10 4l6 6-6 6"/></svg>
                </a>
            <?php else: ?>
                <a href="login.php" class="hidden px-2 py-2 text-xs font-medium text-slate-300 transition hover:text-white sm:inline-flex">Sign in</a>
                <a href="signup.php" class="rounded-full bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-sky-200">Get started <span aria-hidden="true" class="ml-1">↗</span></a>
            <?php endif; ?>
        </div>
    </nav>
</header>

<main>
    <section class="mx-auto max-w-7xl px-4 pb-14 pt-20 sm:px-6 sm:pb-20 sm:pt-28 lg:pt-32">
        <div class="grid items-center gap-14 lg:grid-cols-[1.05fr_.95fr] lg:gap-10">
            <div class="relative z-10">
                <div class="inline-flex items-center gap-2.5 rounded-full border hairline bg-white/[0.025] px-3 py-1.5">
                    <span class="size-1.5 rounded-full bg-emerald-400"></span>
                    <span class="mono text-[10px] uppercase tracking-[.18em] text-slate-400">AI engine <span class="text-slate-200">idle</span></span>
                    <span class="h-3 w-px bg-white/10"></span>
                    <span class="mono text-[10px] text-slate-500">SYSTEM NOMINAL</span>
                </div>

                <h1 class="mt-7 max-w-3xl text-[2.8rem] font-medium leading-[1.04] tracking-[-.065em] text-white sm:text-6xl lg:text-[4.35rem]">
                    Autonomous intelligence for
                    <span class="text-slate-500">high-frequency</span>
                    <span class="text-sky-300">crypto execution.</span>
                </h1>
                <p class="mt-6 max-w-xl text-[15px] leading-7 text-slate-400 sm:text-base">
                    One considered workspace for market structure, execution signals, and on-chain identity—built for operators who move with conviction.
                </p>

                <div class="mt-8 flex flex-wrap items-center gap-3">
                    <?php if ($isLoggedIn): ?>
                        <a href="dashboard.php" class="group inline-flex items-center gap-3 rounded-full bg-slate-100 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-200">
                            Launch web app
                            <span class="grid size-6 place-items-center rounded-full bg-black/[0.07] transition group-hover:translate-x-0.5" aria-hidden="true">↗</span>
                        </a>
                    <?php else: ?>
                        <a href="signup.php" class="group inline-flex items-center gap-3 rounded-full bg-slate-100 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-200">
                            Launch web app
                            <span class="grid size-6 place-items-center rounded-full bg-black/[0.07] transition group-hover:translate-x-0.5" aria-hidden="true">↗</span>
                        </a>
                    <?php endif; ?>
                    <a href="#architecture" class="inline-flex items-center gap-2 rounded-full border border-white/10 px-5 py-3 text-sm font-medium text-slate-300 transition hover:border-white/20 hover:bg-white/[0.035] hover:text-white">
                        Documentation / directory <span aria-hidden="true" class="text-slate-500">↓</span>
                    </a>
                </div>

                <div class="mt-10 flex items-center gap-3 text-xs text-slate-500">
                    <span class="flex -space-x-2">
                        <span class="grid size-7 place-items-center rounded-full border-2 border-[#07090e] bg-slate-800 text-[9px] text-slate-300">Ξ</span>
                        <span class="grid size-7 place-items-center rounded-full border-2 border-[#07090e] bg-slate-800 text-[9px] text-sky-300">₿</span>
                        <span class="grid size-7 place-items-center rounded-full border-2 border-[#07090e] bg-slate-800 text-[9px] text-emerald-300">◎</span>
                    </span>
                    <span>Built for a sharper view of digital markets</span>
                </div>
            </div>

            <div class="relative mx-auto w-full max-w-[34rem]">
                <div class="pointer-events-none absolute inset-x-0 top-0 -z-10 h-full rounded-full bg-sky-400/[0.045] blur-3xl"></div>
                <div class="glass soft-glow overflow-hidden rounded-2xl border border-white/[0.09]">
                    <div class="flex items-center justify-between border-b hairline px-5 py-4">
                        <div class="flex items-center gap-2.5">
                            <span class="grid size-8 place-items-center rounded-lg border border-sky-300/10 bg-sky-300/[0.07] text-sky-300">
                                <svg viewBox="0 0 20 20" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 15.5 7.3 11l2.8 2.4L16.8 6M12.5 6h4.3v4.3"/></svg>
                            </span>
                            <div>
                                <p class="text-xs font-medium text-slate-200">Market intelligence</p>
                                <p class="mono mt-0.5 text-[9px] uppercase tracking-[.15em] text-slate-500">ETH / USD · 1H</p>
                            </div>
                        </div>
                        <span class="mono rounded-md border border-emerald-400/15 bg-emerald-400/[0.06] px-2 py-1 text-[9px] text-emerald-300">DEMO FEED</span>
                    </div>
                    <div class="flex items-end justify-between px-5 pb-2 pt-5">
                        <div>
                            <p class="mono text-[10px] uppercase tracking-[.14em] text-slate-500">Execution overview</p>
                            <p class="mt-2 text-3xl font-medium tracking-[-.05em] text-white">$3,842.18</p>
                        </div>
                        <div class="pb-1 text-right">
                            <p class="mono text-sm text-emerald-400">+2.84%</p>
                            <p class="mono mt-1 text-[9px] text-slate-500">24H CHANGE</p>
                        </div>
                    </div>
                    <div class="px-3 pt-3">
                        <svg viewBox="0 0 600 190" class="h-44 w-full" role="img" aria-label="Illustrative ETH market trend chart">
                            <defs>
                                <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#10b981" stop-opacity=".17"/><stop offset="1" stop-color="#10b981" stop-opacity="0"/></linearGradient>
                                <linearGradient id="chartLine" x1="0" x2="1"><stop offset="0" stop-color="#38bdf8"/><stop offset=".48" stop-color="#10b981"/><stop offset="1" stop-color="#34d399"/></linearGradient>
                            </defs>
                            <path d="M0 42H600M0 87H600M0 132H600M0 177H600" stroke="rgba(148,163,184,.11)" stroke-dasharray="3 7"/>
                            <path d="M0 148 C22 143 30 157 49 142 S78 129 94 137 S119 112 139 121 S166 106 183 116 S209 99 229 108 S249 89 270 101 S299 86 315 91 S340 73 358 83 S383 72 399 79 S427 54 444 68 S465 58 482 65 S500 43 518 54 S542 42 557 49 S583 31 600 36 V190 H0Z" fill="url(#chartFill)"/>
                            <path d="M0 148 C22 143 30 157 49 142 S78 129 94 137 S119 112 139 121 S166 106 183 116 S209 99 229 108 S249 89 270 101 S299 86 315 91 S340 73 358 83 S383 72 399 79 S427 54 444 68 S465 58 482 65 S500 43 518 54 S542 42 557 49 S583 31 600 36" fill="none" stroke="url(#chartLine)" stroke-linecap="round" stroke-width="2.2"/>
                            <circle cx="600" cy="36" r="4" fill="#34d399"/><circle cx="600" cy="36" r="8" fill="#34d399" fill-opacity=".13"/>
                        </svg>
                    </div>
                    <div class="grid grid-cols-3 border-t hairline">
                        <div class="border-r hairline px-5 py-4">
                            <p class="mono text-[9px] uppercase tracking-[.13em] text-slate-500">Signal</p>
                            <p class="mt-1.5 text-xs text-emerald-300">Constructive</p>
                        </div>
                        <div class="border-r hairline px-5 py-4">
                            <p class="mono text-[9px] uppercase tracking-[.13em] text-slate-500">Liquidity</p>
                            <p class="mt-1.5 text-xs text-slate-200">Contraction</p>
                        </div>
                        <div class="px-5 py-4">
                            <p class="mono text-[9px] uppercase tracking-[.13em] text-slate-500">Latency</p>
                            <p class="mt-1.5 text-xs text-slate-200">12 ms</p>
                        </div>
                    </div>
                </div>
                <p class="mono mt-3 text-center text-[9px] uppercase tracking-[.16em] text-slate-600">Illustrative interface · sample market data</p>
            </div>
        </div>
    </section>

    <section id="market-snapshot" aria-label="Market snapshot" class="border-y border-white/[0.06] bg-[#0b0e16]/75">
        <div class="mx-auto max-w-7xl px-4 sm:px-6">
            <div class="market-strip flex snap-x items-center gap-0 overflow-x-auto">
                <div class="flex min-w-max items-center gap-3 py-4 pr-8">
                    <span class="mono text-[9px] uppercase tracking-[.17em] text-slate-600">Sample market snapshot</span>
                    <span class="size-1 rounded-full bg-slate-700"></span>
                    <span class="mono text-[9px] text-slate-500">24H INDICATIVE</span>
                </div>
                <div class="h-8 w-px shrink-0 bg-white/[0.07]"></div>
                <div class="flex min-w-max items-center gap-2.5 px-6 py-4">
                    <span class="mono text-[10px] text-slate-500">BTC / USD</span>
                    <span class="mono text-xs text-slate-200">$67,482.10</span>
                    <span class="mono text-[10px] text-emerald-400">+1.82%</span>
                </div>
                <div class="h-8 w-px shrink-0 bg-white/[0.07]"></div>
                <div class="flex min-w-max items-center gap-2.5 px-6 py-4">
                    <span class="mono text-[10px] text-slate-500">ETH / USD</span>
                    <span class="mono text-xs text-slate-200">$3,842.18</span>
                    <span class="mono text-[10px] text-emerald-400">+2.84%</span>
                </div>
                <div class="h-8 w-px shrink-0 bg-white/[0.07]"></div>
                <div class="flex min-w-max items-center gap-2.5 px-6 py-4">
                    <span class="relative flex size-1.5"><span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-30"></span><span class="relative inline-flex size-1.5 rounded-full bg-emerald-400"></span></span>
                    <span class="mono text-[10px] text-slate-500">AI AGENT</span>
                    <span class="mono text-[10px] text-emerald-300">ONLINE · LOW LATENCY</span>
                </div>
                <div class="h-8 w-px shrink-0 bg-white/[0.07]"></div>
                <div class="flex min-w-max items-center gap-2.5 py-4 pl-6">
                    <span class="mono text-[10px] text-slate-500">LIQUIDITY SIGNAL</span>
                    <span class="mono text-[10px] text-sky-300">CONTRACTION</span>
                </div>
            </div>
        </div>
    </section>

    <section id="architecture" class="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
        <div class="mb-9 flex flex-col justify-between gap-5 sm:mb-11 sm:flex-row sm:items-end">
            <div>
                <p class="mono text-[10px] uppercase tracking-[.2em] text-sky-300/80">The platform</p>
                <h2 class="mt-3 text-3xl font-medium tracking-[-.05em] text-white sm:text-4xl">One portal. Three layers.</h2>
            </div>
            <p class="max-w-sm text-sm leading-6 text-slate-500">A considered entry point for account access, market tools, and your digital identity.</p>
        </div>

        <div class="grid gap-4 md:grid-cols-3">
            <article class="group relative overflow-hidden rounded-2xl border border-white/[0.07] bg-[#0d111c]/80 p-6 transition duration-300 hover:-translate-y-1 hover:border-sky-300/25 hover:bg-[#101622] sm:p-7">
                <div class="absolute right-0 top-0 h-32 w-32 rounded-full bg-sky-400/[0.035] blur-3xl transition group-hover:bg-sky-400/[0.08]"></div>
                <div class="relative">
                    <div class="flex items-start justify-between">
                        <span class="grid size-11 place-items-center rounded-xl border border-sky-300/15 bg-sky-300/[0.06] text-sky-300">
                            <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 2.8 7.5 7 10 4.2-2.5 7-5.5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg>
                        </span>
                        <span class="mono text-[10px] tracking-[.15em] text-slate-600">01 / ACCESS</span>
                    </div>
                    <h3 class="mt-7 text-lg font-medium tracking-[-.02em] text-white">Auth &amp; verification gateway</h3>
                    <p class="mt-2 min-h-12 text-sm leading-6 text-slate-500">Your secure passage in, with email verification at the foundation.</p>
                    <ul class="mt-6 space-y-3 border-t border-white/[0.06] pt-5 text-[13px]">
                        <li><a href="signup.php" class="flex items-center justify-between text-slate-300 transition hover:text-sky-300"><span>Create an account</span><span aria-hidden="true" class="text-slate-600">↗</span></a></li>
                        <li><a href="login.php" class="flex items-center justify-between text-slate-300 transition hover:text-sky-300"><span>Sign in</span><span aria-hidden="true" class="text-slate-600">↗</span></a></li>
                        <li><a href="verify-email.php" class="flex items-center justify-between text-slate-500 transition hover:text-slate-300"><span>Email verification</span><span class="mono text-[9px] text-slate-600">6-DIGIT CODE</span></a></li>
                    </ul>
                </div>
            </article>

            <article class="group relative overflow-hidden rounded-2xl border border-white/[0.07] bg-[#0d111c]/80 p-6 transition duration-300 hover:-translate-y-1 hover:border-emerald-300/20 hover:bg-[#101622] sm:p-7">
                <div class="absolute right-0 top-0 h-32 w-32 rounded-full bg-emerald-400/[0.025] blur-3xl transition group-hover:bg-emerald-400/[0.07]"></div>
                <div class="relative">
                    <div class="flex items-start justify-between">
                        <span class="grid size-11 place-items-center rounded-xl border border-emerald-300/15 bg-emerald-300/[0.055] text-emerald-300">
                            <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13.5 2.8 5 13h6l-.5 8.2L19 11h-6l.5-8.2Z"/></svg>
                        </span>
                        <span class="mono text-[10px] tracking-[.15em] text-slate-600">02 / EXECUTION</span>
                    </div>
                    <h3 class="mt-7 text-lg font-medium tracking-[-.02em] text-white">AI execution &amp; live feeds</h3>
                    <p class="mt-2 min-h-12 text-sm leading-6 text-slate-500">A focused terminal for a clearer read on your account and the market.</p>
                    <ul class="mt-6 space-y-3 border-t border-white/[0.06] pt-5 text-[13px]">
                        <li><a href="dashboard.php" class="flex items-center justify-between text-slate-300 transition hover:text-emerald-300"><span>Open trading terminal</span><span aria-hidden="true" class="text-slate-600">↗</span></a></li>
                        <li class="flex items-center justify-between text-slate-400"><span>Agent stream</span><span class="mono text-[9px] text-slate-600">SYSTEM FEED</span></li>
                        <li class="flex items-center justify-between text-slate-400"><span>Liquidity heatmap</span><span class="mono text-[9px] text-slate-600">MARKET VIEW</span></li>
                    </ul>
                </div>
            </article>

            <article class="group relative overflow-hidden rounded-2xl border border-white/[0.07] bg-[#0d111c]/80 p-6 transition duration-300 hover:-translate-y-1 hover:border-sky-300/25 hover:bg-[#101622] sm:p-7">
                <div class="absolute right-0 top-0 h-32 w-32 rounded-full bg-sky-400/[0.035] blur-3xl transition group-hover:bg-sky-400/[0.08]"></div>
                <div class="relative">
                    <div class="flex items-start justify-between">
                        <span class="grid size-11 place-items-center rounded-xl border border-white/10 bg-white/[0.035] text-slate-300">
                            <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0M18 4.5a3.5 3.5 0 0 1 0 7M20 15a5 5 0 0 1 2 4"/></svg>
                        </span>
                        <span class="mono text-[10px] tracking-[.15em] text-slate-600">03 / IDENTITY</span>
                    </div>
                    <h3 class="mt-7 text-lg font-medium tracking-[-.02em] text-white">Profile &amp; identity layer</h3>
                    <p class="mt-2 min-h-12 text-sm leading-6 text-slate-500">Keep your profile and connected social identity in one place.</p>
                    <ul class="mt-6 space-y-3 border-t border-white/[0.06] pt-5 text-[13px]">
                        <li><a href="settings.php" class="flex items-center justify-between text-slate-300 transition hover:text-sky-300"><span>Profile &amp; X handle sync</span><span aria-hidden="true" class="text-slate-600">↗</span></a></li>
                        <li class="flex items-center justify-between text-slate-400"><span>Verification status</span><span class="mono text-[9px] text-slate-600">ACCOUNT BADGE</span></li>
                        <?php if ($isLoggedIn): ?>
                            <li>
                                <form method="post" action="logout.php">
                                    <input type="hidden" name="csrf_token" value="<?= e(csrf_token()) ?>">
                                    <button type="submit" class="flex w-full items-center justify-between text-left text-slate-400 transition hover:text-rose-300"><span>Sign out</span><span aria-hidden="true" class="text-slate-600">↗</span></button>
                                </form>
                            </li>
                        <?php else: ?>
                            <li><a href="login.php" class="flex items-center justify-between text-slate-400 transition hover:text-sky-300"><span>Sign in to manage identity</span><span aria-hidden="true" class="text-slate-600">↗</span></a></li>
                        <?php endif; ?>
                    </ul>
                </div>
            </article>
        </div>
    </section>
</main>

<footer class="border-t border-white/[0.06] bg-[#090b11]/75">
    <div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-6 text-[11px] text-slate-600 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div class="flex items-center gap-2">
            <span class="grid size-6 place-items-center rounded-md border border-white/[0.07] text-[10px] text-sky-300">Ξ</span>
            <span>© <?= e(date('Y')) ?> ETHcryptohub</span>
            <span class="mx-1 text-slate-800">/</span>
            <span>Built for the on-chain era</span>
        </div>
        <div class="mono flex flex-wrap items-center gap-x-5 gap-y-2 uppercase tracking-[.12em]">
            <span>Ping: <span class="text-emerald-400">12ms</span></span>
            <span>Server time: <time id="server-time" data-epoch="<?= e($serverTime) ?>"><?= e(gmdate('H:i:s', $serverTime)) ?> UTC</time></span>
            <span class="flex items-center gap-2"><span class="size-1.5 rounded-full bg-emerald-400"></span>Systems nominal</span>
        </div>
    </div>
</footer>
<script>
    (() => {
        const clock = document.getElementById('server-time');
        if (!clock) return;
        let epoch = Number(clock.dataset.epoch) * 1000;
        window.setInterval(() => {
            epoch += 1000;
            clock.textContent = new Date(epoch).toISOString().slice(11, 19) + ' UTC';
        }, 1000);
    })();
</script>
</body>
</html>
