import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assessWorkerHealth } from './market-worker-storage.mjs';

export async function checkWorkerHealth(directory,now=Date.now()) {
  try{const text=await fs.readFile(path.join(directory,'health.json'),'utf8');if(Buffer.byteLength(text)>1024*1024)throw Error('OVERSIZED_HEALTH');return assessWorkerHealth(JSON.parse(text),now);}
  catch{return {live:false,ready:false,reason:'HEARTBEAT_UNREADABLE'};}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const result=await checkWorkerHealth(process.argv[2]??'storage/market-intelligence');
  console.log(JSON.stringify(result));process.exitCode=(process.argv.includes('--liveness')?result.live:result.ready)?0:1;
}
