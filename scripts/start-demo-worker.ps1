<#
.SYNOPSIS
  Starts the SmartExit 24x7 Isolated Demo Trading Worker on Windows.
.DESCRIPTION
  Launches the background worker process with persistent file lock, heartbeat monitoring,
  and checkpoint recovery. Press Ctrl+C to initiate graceful shutdown.
#>

param(
  [switch]$Once,
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

$workerArgs = @("scripts/demo-trading-worker.mjs")
if ($Once) {
  $workerArgs += "--once"
}

try {
  & node $workerArgs
} finally {
  Write-Host "[Launcher] Worker process exited." -ForegroundColor Cyan
}
