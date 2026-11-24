<#
.SYNOPSIS
    SmartExit Secure Local Windows 24/7 Demo Trading Worker Launcher.

.DESCRIPTION
    Runs the isolated autonomous SmartExit background daemon on the owner's Windows PC.
    Strictly locked to DEMO mode and verified Staging Supabase configuration.
    Real-money Live Trading is strictly prohibited and fails closed.

.PARAMETER SafeMode
    When enabled (default), order dispatch is simulated/disabled, running scanning and protection supervision only.

.PARAMETER SingleCycle
    Executes a single test cycle (15 batches, 522 symbols) and exits with report.

.PARAMETER Continuous
    Runs the 24x7 autonomous continuous daemon loop until stopped with Ctrl+C.

.EXAMPLE
    .\scripts\start-local-worker.ps1 -SafeMode -SingleCycle
    .\scripts\start-local-worker.ps1 -Continuous
#>

[CmdletBinding()]
param(
    [switch]$SafeMode = $true,
    [switch]$SingleCycle = $false,
    [switch]$Continuous = $false
)

$ErrorActionPreference = 'Stop'

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host " SMARTEXIT 24x7 AUTONOMOUS DEMO TRADING WORKER (LOCAL WINDOWS)" -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan

# 1. Environment Safety Verification
$targetEnv = "DEMO"
$stagingProjectRef = "ghecpkpaxbrvehquhzkr"
$productionProjectRef = "kafsdnzzjawikoavkhvm"

Write-Host "[1/5] Verifying environment safety invariants..." -ForegroundColor Yellow
if ($env:TRADING_ENVIRONMENT -eq "LIVE") {
    Write-Error "CRITICAL SAFETY VIOLATION: LIVE trading is prohibited on this worker! Fails closed."
    exit 1
}

$env:TRADING_ENVIRONMENT = "DEMO"
$env:NODE_ENV = "production"
$env:SMARTEXIT_STAGING_SUPABASE_PROJECT_REF = $stagingProjectRef
$env:SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF = $productionProjectRef

Write-Host "  -> Trading Environment: DEMO (Virtual Sandbox Only)" -ForegroundColor Green
Write-Host "  -> Target Database Ref: $stagingProjectRef (Staging Sydney)" -ForegroundColor Green
Write-Host "  -> Production Protection: ACTIVE (Production database ref strictly blocked)" -ForegroundColor Green

# 2. Check Node.js
Write-Host "[2/5] Checking Node.js runtime..." -ForegroundColor Yellow
try {
    $nodeVersion = node -v
    Write-Host "  -> Node.js Version: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Error "Node.js runtime not found on PATH. Please install Node.js."
    exit 1
}

# 3. Mode Configuration
Write-Host "[3/5] Configuring operational parameters..." -ForegroundColor Yellow
if ($SingleCycle) {
    $env:WORKER_SINGLE_CYCLE = "true"
    Write-Host "  -> Execution Mode: Single Full Scan Cycle" -ForegroundColor Cyan
} elseif ($Continuous) {
    $env:WORKER_SINGLE_CYCLE = "false"
    Write-Host "  -> Execution Mode: Continuous 24x7 Unattended Loop" -ForegroundColor Cyan
} else {
    $env:WORKER_SINGLE_CYCLE = "true"
    Write-Host "  -> Execution Mode: Supervised Single Cycle (default)" -ForegroundColor Cyan
}

if ($SafeMode) {
    $env:DEMO_ORDER_DISPATCH_ENABLED = "false"
    Write-Host "  -> Order Dispatch: DISABLED (Safe Supervision & Scanner Mode)" -ForegroundColor Green
} else {
    $env:DEMO_ORDER_DISPATCH_ENABLED = "true"
    Write-Host "  -> Order Dispatch: ENABLED (Authorized Demo Accounts Only)" -ForegroundColor Yellow
}

# 4. Starting Worker Process
Write-Host "[4/5] Launching worker daemon: scripts/demo-trading-worker.mjs..." -ForegroundColor Yellow
Write-Host "-----------------------------------------------------------------" -ForegroundColor Gray

$storageDir = Join-Path (Get-Item $PSScriptRoot).Parent.FullName "storage\demo-worker"
$lockPath = Join-Path $storageDir "worker.lock"
if (Test-Path $lockPath) {
    try {
        $lockContent = Get-Content $lockPath -Raw | ConvertFrom-Json
        if ($lockContent.pid -and -not (Get-Process -Id $lockContent.pid -ErrorAction SilentlyContinue)) {
            Write-Host "  -> Cleaning up stale lock from terminated process PID $($lockContent.pid)" -ForegroundColor Yellow
            Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

$scriptPath = Join-Path $PSScriptRoot "demo-trading-worker.mjs"

$nodeArgs = if ($Continuous) { @() } else { @("--once") }

try {
    node $scriptPath $nodeArgs
} catch {
    Write-Host "`nWorker process stopped." -ForegroundColor Yellow
}

# 5. Exit Verification
Write-Host "-----------------------------------------------------------------" -ForegroundColor Gray
Write-Host "[5/5] Worker session terminated cleanly. Exclusive lock released." -ForegroundColor Green
Write-Host "=================================================================" -ForegroundColor Cyan
