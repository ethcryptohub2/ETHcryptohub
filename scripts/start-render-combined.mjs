// SmartExit / ETHcryptohub — Render Combined Web & Worker Process Supervisor
// Runs Next.js Web Server AND SmartExit Demo Trading Worker in a single Render instance.
import { spawn } from 'node:child_process';
import process from 'node:process';

const port = process.env.PORT || '10000';
console.log(`[Supervisor] Starting SmartExit Unified Service on Render (Port: ${port})...`);

// 1. Launch Next.js Web Service
const webProcess = spawn('npx', ['next', 'start', '-H', '0.0.0.0', '-p', port], {
  stdio: 'inherit',
  env: { ...process.env, PORT: port },
  shell: process.platform === 'win32',
});

webProcess.on('error', (err) => {
  console.error('[Supervisor] Failed to start Next.js web process:', err);
});

webProcess.on('exit', (code, signal) => {
  console.log(`[Supervisor] Next.js process exited with code ${code} (${signal})`);
  if (code !== 0 && code !== null) {
    process.exit(code);
  }
});

// 2. Launch SmartExit 24x7 Demo Trading Worker Daemon
let workerProcess = null;
const isWorkerEnabled = process.env.DISABLE_EMBEDDED_WORKER !== 'true';

if (isWorkerEnabled) {
  console.log('[Supervisor] Spawning background Demo Trading Worker daemon...');
  workerProcess = spawn('node', ['--import', 'tsx', 'scripts/demo-trading-worker.mjs'], {
    stdio: 'inherit',
    env: { ...process.env },
    shell: process.platform === 'win32',
  });

  workerProcess.on('error', (err) => {
    console.error('[Supervisor] Worker process error:', err);
  });

  workerProcess.on('exit', (code, signal) => {
    console.warn(`[Supervisor] Demo worker process exited with code ${code} (${signal})`);
    // If worker crashes, restart after 10s backoff unless shutting down
    if (!isShuttingDown) {
      console.log('[Supervisor] Restarting worker process in 10s...');
      setTimeout(() => {
        if (!isShuttingDown) {
          workerProcess = spawn('node', ['--import', 'tsx', 'scripts/demo-trading-worker.mjs'], {
            stdio: 'inherit',
            env: { ...process.env },
            shell: process.platform === 'win32',
          });
        }
      }, 10000);
    }
  });
}

// 3. Graceful Shutdown Supervisor
let isShuttingDown = false;
function handleShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Supervisor] Received ${signal}, initiating graceful shutdown...`);

  if (workerProcess && !workerProcess.killed) {
    workerProcess.kill('SIGTERM');
  }
  if (webProcess && !webProcess.killed) {
    webProcess.kill('SIGTERM');
  }

  setTimeout(() => {
    console.warn('[Supervisor] Forcefully terminating child processes...');
    process.exit(0);
  }, 15000);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
