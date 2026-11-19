// Offline allowlisted artifact preparation. Never starts a worker or runs hooks.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PUBLIC_WORKER_FILES = Object.freeze([
  'scripts/market-intelligence-worker.mjs', 'scripts/market-worker-storage.mjs',
  'scripts/check-market-worker-health.mjs', 'lib/intelligence/market-feed.ts',
  'lib/intelligence/market-worker.ts', 'lib/intelligence/contracts.ts',
]);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function buildPublicWorkerBundle(destination) {
  const target=path.resolve(destination);
  // Exclusive directory creation prevents merging into an application checkout,
  // following a destination symlink, or overwriting a previous bundle.
  await fs.mkdir(target,{mode:0o700});
  const files=[];
  for(const name of PUBLIC_WORKER_FILES) {
    const bytes=await fs.readFile(path.join(root,name));
    const file=path.join(target,name);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
    await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});
    files.push({name,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  await fs.writeFile(path.join(target,'package.json'),JSON.stringify({private:true,type:'module',engines:{node:'24.x'}})+'\n',{flag:'wx',mode:0o600});
  await fs.writeFile(path.join(target,'MANIFEST.json'),JSON.stringify({version:1,files},null,2)+'\n',{flag:'wx',mode:0o600});
  return {files:files.map(f=>f.name),activation:'NOT_APPROVED'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv.length!==3) {console.error('Usage: node scripts/build-public-worker-bundle.mjs <new-directory>');process.exitCode=1;}
  else buildPublicWorkerBundle(process.argv[2]).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('Bundle preparation failed; inspect the new destination privately before retrying.');process.exitCode=1;});
}
