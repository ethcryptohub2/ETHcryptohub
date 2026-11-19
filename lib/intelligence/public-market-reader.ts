import { isApprovedAdminDemoStagingTarget, type AdminDemoEnvironment } from '../admin-demo-staging-policy';
import { PublicMarketProjection } from './public-market-projection';
import { PUBLIC_MARKET_SOURCE } from './public-market-source';

export function publicMarketReadsEnabled(env: AdminDemoEnvironment) {
  return env.SMARTEXIT_PUBLIC_MARKET_READS_ENABLED === 'true' &&
    env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF === 'ghecpkpaxbrvehquhzkr' && isApprovedAdminDemoStagingTarget(env);
}
export async function readPublicMarketView(
  env: AdminDemoEnvironment, now: number,
  read: (sourceId: string)=>Promise<{checkpoint:unknown}|null>,
) {
  if(!publicMarketReadsEnabled(env))return {state:'DISABLED' as const,market:null,reason:'Public market reader is not activated.'};
  try {
    const row=await read(PUBLIC_MARKET_SOURCE);
    if(!row)return {state:'UNAVAILABLE' as const,market:null,reason:'No validated public snapshot.'};
    const checkpoint=typeof row.checkpoint==='string'?row.checkpoint:JSON.stringify(row.checkpoint);
    const view=PublicMarketProjection.restore(checkpoint,now).view(now);
    return {state:'SNAPSHOT' as const,market:view,reason:'Public observations are separate from cached scanner research signals.'};
  } catch {return {state:'UNAVAILABLE' as const,market:null,reason:'Public snapshot is unavailable; cached scanner remains independent.'};}
}
