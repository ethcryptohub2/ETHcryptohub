// Local artifact preparation only. No install hooks, packages or networking.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildPublicWorkerBundle } from './build-public-worker-bundle.mjs';
export const DIAGNOSTIC_FILES=Object.freeze(['scripts/windows-public-preflight.mjs','scripts/public-preflight-wire.mjs',
  'scripts/qualify-public-preflight.mjs','deploy/market-worker/soak-watchlist.json']);
export async function buildWindowsPreflightBundle(destination) {
  const target=path.resolve(destination),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const worker=await buildPublicWorkerBundle(target);
  const manifest=JSON.parse(await fs.readFile(path.join(target,'MANIFEST.json'),'utf8'));
  for(const name of DIAGNOSTIC_FILES) {
    const bytes=await fs.readFile(path.join(root,name));await fs.mkdir(path.dirname(path.join(target,name)),{recursive:true});
    await fs.writeFile(path.join(target,name),bytes,{flag:'wx',mode:0o600});manifest.files.push({name,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  manifest.purpose='FINITE_WINDOWS_PUBLIC_ONLY_NOT_APPROVED';
  await fs.writeFile(path.join(target,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  return {files:[...worker.files,...DIAGNOSTIC_FILES],livePreflightApproved:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv.length!==3){console.error('Expected one new local artifact directory.');process.exitCode=1;}
  else buildWindowsPreflightBundle(process.argv[2]).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('Local artifact preparation failed.');process.exitCode=1;});
}
