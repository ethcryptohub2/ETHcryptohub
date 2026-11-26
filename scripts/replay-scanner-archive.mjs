import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const minute = 60_000;
const day = 1440 * minute;
const intervals = { '5m': 5 * minute, '15m': 15 * minute };
const allowedModules = new Set([
  'lib/backtesting-engine.ts', 'lib/backtesting-accounting.ts', 'lib/backtesting-qualification.ts',
  'lib/high-risk-scalping.ts', 'lib/high-risk-scalping-types.ts', 'lib/high-risk-scalping-status.ts',
  'lib/binance-rate-limit.ts', 'lib/candle-cache.ts',
  'smartexit/apps/api/src/services/market-scanner.ts', 'smartexit/apps/api/src/services/binance-futures-markets.ts',
]);
const disabledImports = new Set(['lib/db', 'lib/notifications', 'lib/signal-lifecycle', 'lib/scanner-coins']);

function loadReviewedModules() {
  const cache = new Map();
  function load(relative) {
    if (!allowedModules.has(relative)) throw new Error('Replay module outside the reviewed allowlist.');
    if (cache.has(relative)) return cache.get(relative);
    const filename = path.join(root, relative);
    const replayModule = new Module(filename);
    replayModule.filename = filename;
    replayModule.require = key => {
      if (!key.startsWith('.')) return require(key);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), key));
      if (disabledImports.has(target)) return {};
      return load(target.replace(/(?:\.js)?$/, '.ts'));
    };
    const source = readFileSync(filename, 'utf8');
    replayModule._compile(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, filename);
    cache.set(relative, replayModule.exports);
    return replayModule.exports;
  }
  return {
    ...load('lib/backtesting-qualification.ts'),
    ...load('lib/backtesting-accounting.ts'),
    ...load('lib/backtesting-engine.ts'),
    ...load('lib/high-risk-scalping.ts'),
  };
}

function boundedRead(filename, maximum) {
  const info = statSync(filename);
  if (!info.isFile() || info.size > maximum) throw new RangeError('Historical input exceeds its file limit.');
  const bytes = readFileSync(filename);
  if (bytes.length > maximum) throw new RangeError('Historical input exceeds its file limit.');
  return bytes;
}

function checkedBytes(filename, sha256, maximum) {
  const bytes = boundedRead(filename, maximum);
  if (!/^[a-f0-9]{64}$/.test(sha256) || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error('Historical input checksum mismatch.');
  }
  return bytes;
}

export function readHistoricalKlines(filename, sha256, interval) {
  const bytes = checkedBytes(filename, sha256, 16 * 1024 * 1024);
  return parseHistoricalKlines(bytes, interval);
}

export function parseHistoricalKlines(bytes, interval) {
  const lines = bytes.toString('utf8').trimEnd().split(/\r?\n/);
  if (lines[0]?.startsWith('open_time,open,high,low,close,volume,close_time,')) lines.shift();
  if (!lines.length || lines.length > 40_000) throw new Error('Historical CSV row count is outside its limit.');
  return lines.map((line, index) => {
    const values = line.split(',');
    if (values.length !== 12 || values.some(value => !/^\d+(?:\.\d+)?$/.test(value))) {
      throw new Error('Unexpected historical Binance kline CSV schema.');
    }
    const [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades] = values.map(Number);
    if (![openTime, closeTime, trades].every(Number.isSafeInteger) || openTime < 0 || openTime % interval !== 0 ||
        closeTime !== openTime + interval - 1 || ![open, high, low, close].every(value => Number.isFinite(value) && value > 0) ||
        high < Math.max(open, close) || low > Math.min(open, close) ||
        ![volume, quoteVolume].every(value => Number.isFinite(value) && value >= 0) ||
        (index > 0 && openTime !== Number(lines[index - 1].split(',', 1)[0]) + interval)) {
      throw new Error('Invalid, duplicate or discontinuous historical kline.');
    }
    const raw = [openTime, ...values.slice(1, 6), closeTime];
    return { openTime, closeTime, open, high, low, close, quoteVolume, trades, raw };
  });
}

function utcBoundary(value) {
  const timestamp = Date.parse(value);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(value) ||
      !Number.isSafeInteger(timestamp) || new Date(timestamp).toISOString().replace('.000Z', 'Z') !== value) {
    throw new Error('Replay boundaries require canonical UTC midnight timestamps.');
  }
  return timestamp;
}

export function readHistoricalFunding(folder, symbol, data) {
  if (data === undefined) return null;
  const { file, sha256, from, through, provenance } = data;
  const fromAt = utcBoundary(from);
  const throughAt = utcBoundary(through);
  if (file !== `${symbol}-funding.json` || fromAt >= throughAt ||
      typeof provenance !== 'string' || !provenance.trim() || provenance.length > 200) {
    throw new Error('Invalid funding file or coverage evidence.');
  }
  const events = JSON.parse(checkedBytes(path.join(folder, file), sha256, 1024 * 1024));
  if (!Array.isArray(events) || events.length > 5000) throw new Error('Invalid historical funding event count.');
  let previous = -Infinity;
  for (const { timestamp, markPrice, rate } of events) {
    if (!Number.isSafeInteger(timestamp) || timestamp < fromAt || timestamp >= throughAt ||
        timestamp <= previous || !Number.isFinite(markPrice) || markPrice <= 0 ||
        !Number.isFinite(rate) || Math.abs(rate) > 0.1) {
      throw new Error('Invalid or duplicate historical funding event.');
    }
    previous = timestamp;
  }
  return { fromAt, throughAt, events, evidence: { file, sha256, from, through, provenance } };
}

export function fundingForFill(source, enteredAt, exitedAt, interval) {
  const entryBarAt = Math.floor(enteredAt / interval) * interval;
  const exitBarAt = Math.floor(exitedAt / interval) * interval;
  if (!source || entryBarAt < source.fromAt || exitedAt >= source.throughAt ||
      source.events.some(({ timestamp }) => (timestamp >= entryBarAt && timestamp <= enteredAt) ||
        (timestamp >= exitBarAt && timestamp <= exitedAt))) return null;
  return source.events.filter(event => event.timestamp > enteredAt && event.timestamp < exitedAt);
}

function tickerFromClosedBars(bars, index, interval) {
  const window = bars.slice(index - day / interval, index);
  const first = window[0];
  const last = window.at(-1);
  return {
    lastPrice: last.close,
    priceChangePercent24h: 100 * (last.close / first.open - 1),
    quoteVolume24h: window.reduce((sum, bar) => sum + bar.quoteVolume, 0),
    tradeCount24h: window.reduce((sum, bar) => sum + bar.trades, 0),
  };
}

export async function replayHistoricalArchive(manifestPath) {
  const manifest = JSON.parse(boundedRead(manifestPath, 64 * 1024));
  const { trainingStart, validationStart, testStart, end, instruments, startingEquity, tradeNotional } = manifest;
  const [trainingAt, validationAt, testAt, endAt] = [trainingStart, validationStart, testStart, end].map(utcBoundary);
  if (!(trainingAt < validationAt && validationAt < testAt && testAt < endAt) || endAt - trainingAt > 100 * day ||
      !Array.isArray(instruments) || instruments.length < 1 || instruments.length > 2 ||
      !Number.isFinite(startingEquity) || !Number.isFinite(tradeNotional) || tradeNotional <= 0 ||
      tradeNotional * instruments.length > startingEquity) throw new Error('Invalid bounded historical replay scope.');
  const sources = new Map();
  for (const { symbol, eligibleFrom, eligibleThrough, provenance, files, funding } of instruments) {
    if (!['BTCUSDT', 'ETHUSDT'].includes(symbol) || sources.has(symbol) ||
        typeof provenance !== 'string' || !provenance.trim() || provenance.length > 200 ||
        utcBoundary(eligibleFrom) > trainingAt || utcBoundary(eligibleThrough) < endAt) {
      throw new Error('Verified point-in-time eligibility is required for the complete period.');
    }
    const series = {};
    for (const [timeframe, interval] of Object.entries(intervals)) {
      const inputs = files?.[timeframe];
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > 3) throw new Error('Expected one to three checked CSV files.');
      const bars = inputs.flatMap(input => {
        if (typeof input?.file !== 'string' || !/^[A-Za-z0-9_.-]+\.csv$/.test(input.file) ||
            !input.file.startsWith(`${symbol}-${timeframe}`)) {
          throw new Error('Historical CSV files must be alongside the local manifest.');
        }
        return readHistoricalKlines(path.join(path.dirname(manifestPath), input.file), input.sha256, interval);
      });
      if (bars[0]?.openTime !== trainingAt || bars.at(-1)?.closeTime !== endAt - 1 ||
          bars.some((bar, index) => bar.openTime !== trainingAt + index * interval)) {
        throw new Error('Historical coverage does not match the manifest period.');
      }
      series[timeframe] = bars;
    }
    sources.set(symbol, { series, files, eligibilityProvenance: provenance,
      funding: readHistoricalFunding(path.dirname(manifestPath), symbol, funding),
      eligibleAt: utcBoundary(eligibleFrom), eligibleUntil: utcBoundary(eligibleThrough) });
  }
  if (!sources.has('BTCUSDT')) throw new Error('BTCUSDT archive is required for historical High-Risk context.');
  const { qualifyHistoricalSignal, accountHistoricalReplay, evaluateHistoricalSignal, defaultHighRiskScalpingSettings } = loadReviewedModules();
  const highRiskSettings = { ...defaultHighRiskScalpingSettings(), enabled: true };
  const feeBps = 5;
  const segments = [];
  for (const [name, start, stop] of [['validation', validationAt, testAt], ['test', testAt, endAt]]) {
    for (const [strategy, timeframe] of [['STANDARD', '15m'], ['HIGH_RISK', '5m']]) {
      const interval = intervals[timeframe];
      const counts = { opportunities: 0, activePositionSkipped: 0, qualified: 0, wait: 0, invalidLevels: 0 };
      const outcomes = {};
      const fills = [];
      for (const [symbol, source] of sources) {
        const bars = source.series[timeframe];
        let activeUntil = 0;
        for (let asOf = start; asOf < stop; asOf += interval) {
          counts.opportunities++;
          if (asOf < activeUntil) { counts.activePositionSkipped++; continue; }
          const index = (asOf - trainingAt) / interval;
          if (index < Math.max(200, day / interval)) throw new Error('Training period is too short for historical warm-up.');
          const ticker = tickerFromClosedBars(bars, index, interval);
          const market = { exchange: 'BINANCE', market: 'USDⓈ-M FUTURES', source: 'ARCHIVE_CLOSED_KLINE_PROXY',
            updatedAt: new Date(asOf - 1).toISOString(), symbols: [{ symbol, baseAsset: symbol.slice(0, -4),
              quoteAsset: 'USDT', contractType: 'PERPETUAL', ...ticker }] };
          const outcome = await qualifyHistoricalSignal({ asOf, eligibleAt: source.eligibleAt, eligibleUntil: source.eligibleUntil,
            market, candles: bars.slice(Math.max(0, index - 400), index).map(bar => bar.raw),
            minimumStandardScore: 60, strategy, timeframe, highRiskSettings,
            btcContext: { observedAt: asOf - 1, changePercent: tickerFromClosedBars(
              sources.get('BTCUSDT').series[timeframe], index, interval).priceChangePercent24h } });
          const standard = outcome.candidate;
          const setup = strategy === 'STANDARD' ? standard?.status === 'READY' && standard.setup : outcome.setup;
          if (!setup || (strategy === 'STANDARD' && (!standard.supertrend.atr || standard.side === 'WAIT'))) {
            counts.wait++;
            continue;
          }
          counts.qualified++;
          const validity = strategy === 'STANDARD' ? 25 : highRiskSettings.signalValidityMinutes[timeframe];
          const entryValidity = strategy === 'STANDARD' ? validity : highRiskSettings.entryValidityMinutes[timeframe];
          const signal = { id: `${strategy}:${symbol}:${asOf}`, strategy, side: standard?.side ?? setup.side,
            generatedAt: asOf, entryExpiresAt: asOf + entryValidity * minute, expiresAt: asOf + validity * minute,
            candleIntervalMs: interval, entryPrice: setup.entryPrice, stop: setup.initialStop ?? setup.stop,
            entryZoneLow: setup.entryZoneLow ?? Math.max(setup.entryPrice * 0.000001, setup.entryPrice - standard.supertrend.atr * 0.25),
            entryZoneHigh: setup.entryZoneHigh ?? setup.entryPrice + standard.supertrend.atr * 0.25,
            tp1: setup.tp1, tp2: setup.tp2, tp3: setup.tp3 ?? null };
          let evaluated;
          try {
            evaluated = evaluateHistoricalSignal(signal, bars.slice(index, index + Math.ceil(validity * minute / interval)), stop);
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            counts.invalidLevels++;
            continue;
          }
          outcomes[evaluated.status] = (outcomes[evaluated.status] ?? 0) + 1;
          activeUntil = signal.expiresAt;
          const exited = evaluated.events.at(-1);
          const entered = evaluated.events.find(event => event.type === 'ENTRY_REACHED');
          if (entered && exited && evaluated.simulatedExit !== null) {
            activeUntil = Math.max(entered.observedAt, exited.observedAt) + 1;
            if (exited.observedAt > entered.observedAt) fills.push({
              id: signal.id, side: signal.side, entry: evaluated.simulatedEntry, exit: evaluated.simulatedExit,
              enteredAt: entered.observedAt, exitedAt: exited.observedAt,
              quantity: tradeNotional / evaluated.simulatedEntry,
              funding: fundingForFill(source.funding, entered.observedAt, exited.observedAt, interval),
            });
          }
        }
      }
      segments.push({ name, strategy, timeframe, start, stop, counts, outcomes, accountedTrades: fills.length,
        accounting: [2, 5].map(slippageBps => ({ feeBps, slippageBps,
          ...accountHistoricalReplay(fills, { feeBps, slippageBps }, startingEquity) })) });
    }
  }
  return { simulation: true, realExchangePerformance: false, trainingStart, validationStart, testStart, end,
    instruments: Array.from(sources, ([symbol, source]) => ({ symbol, eligibilityProvenance: source.eligibilityProvenance,
      fundingCoverage: source.funding?.evidence ?? null,
      archives: Object.fromEntries(Object.entries(intervals).map(([timeframe]) => [timeframe,
        source.files[timeframe].map(({ file, sha256 }) => ({ file, sha256 }))])) })),
    assumptions: { startingEquity, tradeNotional, feeBps, slippageBps: [2, 5],
      funding: 'Applied only from checksum-pinned files with operator-attested complete coverage and unambiguous settlement timing',
      pricing: 'Prior fully closed trade-price candle and rolling 24h closed-kline context, not archived point-in-time tickers',
      exit: 'Standard TP3, High-Risk TP2, earlier targets informational, no carry between validation and test',
      sameBarFills: 'Excluded from accounting when timing cannot establish entry before exit' },
    segments };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node scripts/replay-scanner-archive.mjs <local-manifest.json>');
    process.exitCode = 1;
  } else {
    replayHistoricalArchive(path.resolve(args[0]))
      .then(report => console.log(JSON.stringify(report, null, 2)))
      .catch(error => { console.error(`Historical scanner replay failed: ${error instanceof Error ? error.message : 'unknown error'}`); process.exitCode = 1; });
  }
}
