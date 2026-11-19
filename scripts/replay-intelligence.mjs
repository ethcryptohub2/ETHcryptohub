// Offline only: JSON event input, no network transport, credentials or exchange API.
import fs from 'node:fs/promises';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
function trustedReplayModule() {
  const cache = new Map();
  function compile(name) {
    if (cache.has(name)) return cache.get(name);
    if (!['research-engine', 'research-replay'].includes(name)) throw Error('Unsupported research module.');
    const filename = path.join(root, 'lib', 'intelligence', `${name}.ts`);
    const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod.require = key => key === './research-engine' ? compile('research-engine') : require(key);
    // Only reviewed repository source is compiled; input events are parsed JSON.
    return fs.readFile(filename, 'utf8').then(source => {
      mod._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
      cache.set(name, mod.exports); return mod.exports;
    });
  }
  // CommonJS require is synchronous, so compile dependencies before their caller.
  return compile('research-engine').then(() => compile('research-replay'));
}

export async function runOfflineReplay(inputPath, options = {}) {
  if (!inputPath || !options || Object.keys(options).some(key => !['trainingEvents', 'testEvents'].includes(key))) throw Error('An offline event file and supported evaluation options are required.');
  const input = path.resolve(inputPath);
  if ((await fs.stat(input)).size > 10 * 1024 * 1024) throw Error('Replay input exceeds 10 MiB.');
  const events = JSON.parse(await fs.readFile(input, 'utf8'));
  if (!Array.isArray(events)) throw Error('Replay input must be a JSON array.');
  const engine = await trustedReplayModule();
  const result = engine.replayResearch(events);
  return { ...result, ...(options.trainingEvents !== undefined || options.testEvents !== undefined
    ? { walkForward: engine.walkForwardEvaluation(events, options) } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('--')) {
    console.error('Usage: npm run replay:intelligence -- <offline-events.json>'); process.exitCode = 1;
  } else {
    runOfflineReplay(args[0]).then(result => console.log(JSON.stringify(result, null, 2))).catch(() => {
      console.error('Offline replay failed. Verify ordered events, availability timestamps and bounded input; no worker or orders were started.'); process.exitCode = 1;
    });
  }
}
