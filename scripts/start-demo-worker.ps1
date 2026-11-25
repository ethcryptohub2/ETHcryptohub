<#
.SYNOPSIS
  Starts the SmartExit 24x7 Isolated Demo Trading Worker on Windows.
.DESCRIPTION
  Launches the background worker process using pinned local tsx runtime (no npx download),
  with persistent file lock, distributed DB lease, heartbeat monitoring, and checkpoint recovery.
#>

param(
  [switch]$Once,
  [switch]$SafeMode = $true,
  [string]$Environment = "DEMO"
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " SmartExit 24x7 Demo Trading Worker (Windows Launcher)   " -ForegroundColor Cyan
Write-Host " Environment: $Environment                                " -ForegroundColor Yellow
Write-Host " Mode: Isolated Demo / Testnet Sandbox (Live Locked)     " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan

if ($Environment -eq "LIVE") {
  Write-Error "SECURITY VIOLATION: demo-trading-worker is strictly isolated to DEMO / TESTNET environments."
  exit 1
}

$env:TRADING_ENVIRONMENT = $Environment
$env:SMARTEXIT_TRADING_ENVIRONMENT = $Environment
$env:SMARTEXIT_DEPLOYMENT_ENV = "staging"
$env:BINANCE_FUTURES_LIVE_TRADING_APPROVED = "false"
if ($SafeMode) {
  $env:WORKER_SAFE_MODE = "true"
  $env:DEMO_ORDER_DISPATCH_ENABLED = "false"
} else {
  $env:WORKER_SAFE_MODE = "false"
  $env:DEMO_ORDER_DISPATCH_ENABLED = "true"
}

$workerArgs = @("--import", "tsx", "scripts/demo-trading-worker.mjs")
if ($Once) {
  $workerArgs += "--once"
}

try {
  & node @workerArgs
} finally {
  Write-Host "[Launcher] Worker process exited." -ForegroundColor Cyan
}
