import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { guardedPost } from '../../../../lib/http';
import { readPublicMarketStatus } from '../../../../lib/intelligence/public-market-server-reader';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(request:NextRequest) {
  try {
    await requireUser();
    if(request.nextUrl.search)return json({error:'Source, account and tenant overrides are not supported.'},422);
    return json({data:await readPublicMarketStatus()});
  }catch(error){return json({error:error instanceof AuthError?error.message:'Public market status unavailable.'},error instanceof AuthError?error.status:503);}
}
export async function POST(request:NextRequest) {
  try {
    await requireUser();const rejected=guardedPost(request);if(rejected)return rejected;
    return json({error:'Remote public ingestion is not activated.',code:'PUBLIC_MARKET_INGESTION_DISABLED'},503);
  }catch(error){return json({error:error instanceof AuthError?error.message:'Public ingestion unavailable.'},error instanceof AuthError?error.status:503);}
}
